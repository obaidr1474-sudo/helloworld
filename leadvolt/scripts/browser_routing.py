"""Business workflow UI checks; uses only fictional data in a new workspace.
Requires a local development API + Vite and Python Playwright with Chromium.
"""
import hashlib, hmac, json, os, re, shutil, time
from pathlib import Path
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('LEADVOLT_URL','http://localhost:5173')
OUT=Path(os.environ.get('LEADVOLT_REVIEW_DIR','/tmp/leadvolt-routing-review'))
OUT.mkdir(parents=True,exist_ok=True)
checks=[]
def passed(name):
    checks.append(name)
    print('PASS:',name,flush=True)
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
    owner=browser.new_context(viewport={'width':1440,'height':1000},timezone_id='Asia/Dubai')
    page=owner.new_page();page.set_default_timeout(10000)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    slug='routing-ui-'+uuid4().hex[:10];password='fictional-test-only-123'
    r=owner.request.post(BASE+'/api/v1/auth/register',data={'company':'Routing Review (fictional)','slug':slug,'name':'Review Admin','email':'owner@example.test','password':password})
    assert r.ok,r.text()
    token=r.json()['token']
    def api(method,path,body=None):
        r=owner.request.fetch(BASE+'/api/v1'+path,method=method,data=body,headers={'Authorization':'Bearer '+token})
        assert r.ok,f'{path}: {r.status} {r.text()}'
        return r.json()
    agent=api('POST','/users',{'name':'Responsible Agent No BRN','email':'responsible@example.test','password':password,'role':'agent'})
    publisher=api('POST','/users',{'name':'Licensed Publisher','email':'publisher@example.test','password':password,'role':'agent','brokerRegistrationNumber':'FICTIONAL-BRN'})
    secret=api('POST','/settings/intake-secret/reveal',{})['secret']
    def deliver(ref,phone,name,event):
        raw=json.dumps({'contact':{'name':name,'phone':phone},'listing':{'reference':ref}},separators=(',',':'))
        timestamp=str(int(time.time()))
        signature='sha256='+hmac.new(secret.encode(),(timestamp+'.bayut.'+raw).encode(),hashlib.sha256).hexdigest()
        r=owner.request.post(BASE+'/api/v1/intake/portal?source=bayut',data=raw,headers={'content-type':'application/json','x-leadvolt-workspace':slug,'x-leadvolt-timestamp':timestamp,'x-leadvolt-signature':signature,'x-leadvolt-event-id':event})
        assert r.ok,f'intake {r.status} {r.text()}'
        return r.json()
    first=deliver('BAY-NEW-100','+971503001001','First unmapped buyer','ui-first')
    assert first['ownerId'] is None
    page.goto(BASE+'/#/operations')
    expect(page.get_by_role('heading',name='Operations centre',exact=True)).to_be_visible()
    row=page.get_by_role('row').filter(has_text='First unmapped buyer')
    expect(row).to_contain_text('Listing owner not mapped')
    row.get_by_role('button',name='Resolve ownership',exact=True).click()
    modal=page.get_by_role('dialog',name='Resolve ownership · First unmapped buyer',exact=True)
    modal.get_by_role('combobox',name='Assign enquiry to',exact=True).select_option(agent['id'])
    modal.get_by_role('button',name='Assign & remember listing owner',exact=True).click()
    expect(modal).to_have_count(0)
    expect(page.get_by_role('heading',name='No enquiries waiting for ownership',exact=True)).to_be_visible()
    assert api('GET','/leads/'+first['leadId'])['ownerId']==agent['id']
    passed('admin resolves an unknown Bayut reference and saves the responsible agent without a BRN')
    page.get_by_role('button',name='Listing ownership',exact=True).click()
    mappingrow=page.get_by_role('row').filter(has_text='BAY-NEW-100')
    mappingrow.get_by_role('button',name='Edit mapping',exact=True).click()
    mapping=page.get_by_role('dialog',name='Edit listing ownership',exact=True)
    mapping.get_by_role('combobox',name='Publishing agent',exact=True).select_option(publisher['id'])
    mapping.get_by_role('button',name='Save mapping & assign waiting leads',exact=True).click()
    expect(mapping).to_have_count(0)
    expect(mappingrow).to_contain_text('Responsible Agent No BRN')
    expect(mappingrow).to_contain_text('Licensed Publisher')
    second=deliver('BAY-NEW-100','+971503001002','Future mapped buyer','ui-future')
    assert second['ownerId']==agent['id']
    assert deliver('BAY-NEW-100','+971503001002','Future mapped buyer','ui-future')['leadId']==second['leadId']
    passed('publisher remains separate, future enquiries route automatically, and provider retries do not duplicate')
    page.screenshot(path=str(OUT/'listing-ownership.png'),full_page=True)
    agentctx=browser.new_context(viewport={'width':1440,'height':1000},timezone_id='Asia/Dubai')
    login=agentctx.request.post(BASE+'/api/v1/auth/login',data={'workspace':slug,'email':'responsible@example.test','password':password});assert login.ok
    apage=agentctx.new_page();apage.set_default_timeout(10000);apage.on('pageerror',lambda e:errors.append(str(e)))
    apage.goto(BASE+'/#/operations')
    expect(apage.get_by_role('heading',name='My day',exact=True)).to_be_visible()
    expect(apage.get_by_role('button',name='Listing ownership',exact=True)).to_have_count(0)
    arow=apage.get_by_role('row').filter(has_text='First unmapped buyer')
    arow.get_by_role('button',name='Acknowledge',exact=True).click()
    expect(arow.get_by_role('button',name='Acknowledge',exact=True)).to_have_count(0)
    assert api('GET','/leads/'+first['leadId'])['lastAgentUpdateAt'] is None
    passed('agent sees My day and acknowledges receipt separately from the daily update')
    arow.get_by_role('button',name='Open & update',exact=True).click()
    drawer=apage.get_by_role('dialog',name='Lead details: First unmapped buyer',exact=True)
    expect(drawer).to_be_visible()
    expect(drawer.get_by_role('button',name=re.compile('^Assign'))).to_have_count(0)
    drawer.get_by_role('textbox',name='Note',exact=True).fill('Spoke with this buyer; arranging a viewing tomorrow.')
    drawer.get_by_role('button',name='Add note',exact=True).click()
    expect(drawer.get_by_text('Spoke with this buyer; arranging a viewing tomorrow.',exact=True)).to_be_visible()
    assert api('GET','/leads/'+first['leadId'])['lastAgentUpdateAt'] is not None
    apage.get_by_role('button',name='Close lead details',exact=True).click()
    apage.get_by_role('button',name='My day',exact=True).click()
    expect(apage.get_by_role('row').filter(has_text='First unmapped buyer')).to_have_count(0)
    passed('a meaningful agent update clears that lead from today’s required updates')
    apage.screenshot(path=str(OUT/'agent-my-day.png'),full_page=True)
    page.get_by_role('button',name='Daily team updates',exact=True).click()
    expect(page.get_by_role('row').filter(has_text='Responsible Agent No BRN')).to_contain_text('BRN not recorded')
    page.get_by_role('button',name='Integration activity',exact=True).click()
    expect(page.get_by_role('row').filter(has_text='ui-future').filter(has_text='duplicate')).to_be_visible()
    page.get_by_role('button',name='Audit history',exact=True).click()
    expect(page.get_by_role('table')).to_contain_text('listing_route')
    passed('admin monitors team accountability, duplicate delivery receipts and audit history')
    page.screenshot(path=str(OUT/'audit-history.png'),full_page=True)
    page.get_by_role('button',name='Routing exceptions',exact=False).click()
    third=deliver('BAY-NEW-200','+971503001003','Mobile unresolved buyer','ui-mobile')
    expect(page.get_by_role('row').filter(has_text='Mobile unresolved buyer')).to_be_visible()
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
    page.screenshot(path=str(OUT/'operations-mobile.png'),full_page=True)
    passed('operations exceptions remain usable on a phone viewport')
    assert apage.evaluate("localStorage.getItem('lv_token')") is None
    apage.get_by_role('button',name='Sign out',exact=True).click()
    expect(apage.get_by_role('heading',name='Sign in to LeadVolt',exact=False)).to_be_visible()
    assert (agentctx.request.get(BASE+'/api/v1/me')).status==401
    passed('browser authentication uses cookies and signing out revokes access')
    assert not errors,errors
    (OUT/'results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'page_errors':errors},indent=2))
    browser.close()
