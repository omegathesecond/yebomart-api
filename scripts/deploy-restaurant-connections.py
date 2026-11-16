"""Provision only the product-scoped restaurant connection secrets; never print values."""
import json,secrets,subprocess

def g(*args,content=None,check=True):
 p=subprocess.run(['gcloud','--configuration=deployer',*args,'--project=hiyebo'],input=content,capture_output=True,text=True)
 if check and p.returncode:raise RuntimeError(p.stderr)
 return p

def service(name):
 return json.loads(g('run','services','describe',name,'--region=europe-west1','--format=json').stdout)['spec']['template']['spec']['serviceAccountName']
mart=service('yebomart-api-prod');ai=service('yeboai-api-prod')
if mart!='yebomart-runtime@hiyebo.iam.gserviceaccount.com' or ai!='yeboai-runtime@hiyebo.iam.gserviceaccount.com':raise SystemExit('Runtime identity changed; inspect before provisioning.')
for name,accounts in [('YEBOMART__YEBOAI_API_KEY',[mart,ai]),('YEBOMART__RESTAURANT_CREDENTIAL_KEY',[mart])]:
 existing=g('secrets','describe',name,'--format=value(name)',check=False)
 if existing.returncode:
  if 'NOT_FOUND' not in existing.stderr:raise RuntimeError(existing.stderr)
  g('secrets','create',name,'--replication-policy=automatic')
  g('secrets','versions','add',name,'--data-file=-',content=secrets.token_hex(32))
 for account in accounts:g('secrets','add-iam-policy-binding',name,'--member=serviceAccount:'+account,'--role=roles/secretmanager.secretAccessor','--quiet')
 print('Ready:',name,'for',','.join(accounts))
