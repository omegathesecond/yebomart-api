#!/usr/bin/env python3
"""Read-only release assertion. Pass the exact production deployment commit SHA and build ID."""
import json
import subprocess
import sys
import urllib.request

commit = sys.argv[1]
assert len(commit) == 40 and all(c in '0123456789abcdef' for c in commit), 'Full commit SHA required'

def gcloud(*args):
    return json.loads(subprocess.check_output([
        'gcloud', '--configuration=deployer', *args, '--project=hiyebo', '--format=json'
    ], text=True, timeout=60))

# A pushed branch and a healthy endpoint alone do not prove a completed release.
build = gcloud('builds', 'describe', sys.argv[2])
assert build.get('status') == 'SUCCESS', 'Production build has not succeeded'
assert build.get('substitutions', {}).get('COMMIT_SHA') == commit, 'Build commit differs'
assert build.get('substitutions', {}).get('_SERVICE') == 'yebomart-api-prod', 'Not a production build'
service = gcloud('run', 'services', 'describe', 'yebomart-api-prod', '--region=europe-west1')
traffic = [t for t in service['status']['traffic'] if t.get('percent', 0)]
assert len(traffic) == 1 and traffic[0]['percent'] == 100, 'Expected one revision at 100% traffic'
revision = gcloud('run', 'revisions', 'describe', traffic[0]['revisionName'], '--region=europe-west1')
assert any(c['type'] == 'Ready' and c['status'] == 'True' for c in revision['status']['conditions'])
digest = revision['status']['imageDigest'].split('@')[-1]
assert any(image['digest'] == digest for image in build['results']['images']), 'Live image differs from completed build'
for annotations, name in [
    (service['metadata'].get('annotations', {}), 'service'),
    (service['spec']['template']['metadata'].get('annotations', {}), 'revision'),
]:
    for key in ['run.googleapis.com/minScale', 'autoscaling.knative.dev/minScale']:
        assert int(annotations.get(key, '0')) == 0, f'{name} minimum instances is not zero'

# Exercise the same API-wide limiter as the incident, without invoking the
# billing runner (which can perform payment-related work). Caller-controlled
# prefixes must not create fresh buckets on either production ingress path.
for base in ['https://api.yebomart.com', service['status']['url']]:
    remaining = []
    for spoof in ['192.0.2.101', '192.0.2.102']:
        req = urllib.request.Request(base + '/api/billing/plans', headers={'X-Forwarded-For': spoof})
        with urllib.request.urlopen(req, timeout=45) as response:
            assert response.status == 200
            payload = json.load(response)
            assert payload['success'] is True and payload['data']['plans'], 'Plans journey did not return plans'
            assert int(response.headers['RateLimit-Limit']) == 10000
            remaining.append(int(response.headers['RateLimit-Remaining']))
    assert remaining[1] < remaining[0], 'Spoofed prefix changed the client rate-limit bucket'
    with urllib.request.urlopen(base + '/health/ready', timeout=45) as response:
        assert response.status == 200 and json.load(response)['ready'] is True
    print(f'PASS {base}: read-only plans journey, spoof-resistant limiter and readiness', flush=True)
print(f'PASS production commit {commit}, build image {digest}, revision {traffic[0]["revisionName"]}, 100% traffic, zero minimum instances')
