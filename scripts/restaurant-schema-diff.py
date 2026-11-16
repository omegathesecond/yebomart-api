import os,subprocess,pathlib
result=subprocess.run(['npx','prisma','migrate','diff','--from-url',os.environ['DATABASE_URL'],'--to-schema-datamodel','prisma/schema.prisma','--script'],capture_output=True,text=True)
if result.returncode:raise SystemExit('Schema inspection failed: '+result.stderr.replace(os.environ['DATABASE_URL'],'[redacted]'))
path=pathlib.Path('/tmp/yebomart-restaurant-'+os.environ['PGDATABASE']+'-diff.sql');path.write_text(result.stdout)
print('Schema diff saved to',path)
print(result.stdout)
