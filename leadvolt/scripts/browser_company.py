"""Company controls UI acceptance, with fictional isolated workspaces only."""
import base64, csv, hashlib, hmac, io, json, os, re, shutil, struct, time
from pathlib import Path
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('LEADVOLT_URL','http://localhost:5173')
OUT=Path(os.environ.get('LEADVOLT_REVIEW_DIR','/tmp/leadvolt-company-review'));OUT.mkdir(parents=True,exist_ok=True)
checks=[]
def passed(name):checks.append(name);print('PASS:',name,flush=True)
def totp(secret):
    key=base64.b32decode(secret+'='*((8-len(secret)%8)%8));value=hmac.new(key,struct.pack('>Q',int(time.time())//30),hashlib.sha1).digest();offset=value[-1]&15
    return str((struct.unpack('>I',value[offset:offset+4])[0]&0x7fffffff)%1000000).zfill(6)
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
    ctx=browser.new_context(viewport={'width':1440,'height':1050},timezone_id='Asia/Dubai',accept_downloads=True)
    page=ctx.new_page();page.set_default_timeout(10000);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    slug='company-ui-'+uuid4().hex[:10];password='fictional-company-only-123'
    r=ctx.request.post(BASE+'/api/v1/auth/register',data={'company':'Company Acceptance (fictional)','slug':slug,'name':'Company Owner','email':'owner@company.test','password':password});assert r.ok,r.text()
    def api(method,path,body=None,context=ctx):
        res=context.request.fetch(BASE+'/api/v1'+path,method=method,data=body,headers={'x-leadvolt-csrf':'1'})
        assert res.ok,f'{method} {path}: {res.status} {res.text()}'
        return res.json() if res.status!=204 else None
    owner=api('GET','/me')
    agent=api('POST','/users',{'name':'Daily Agent','email':'agent@company.test','password':password,'role':'agent'})
    ownlead=api('POST','/leads',{'name':'Management buyer private','phone':'+971506001001','source':'website','ownerId':owner['id']})['lead']
    agentlead=api('POST','/leads',{'name':'Management buyer agent','phone':'+971506001002','source':'website','ownerId':agent['id']})['lead']
    page.goto(BASE+'/#/security')
    page.get_by_role('button',name='Set up two-factor',exact=True).click()
    setup=page.get_by_role('dialog',name='Set up two-factor',exact=True)
    setup.get_by_role('textbox',name='Current password',exact=True).fill(password)
    setup.get_by_role('button',name='Continue',exact=True).click()
    confirm=page.get_by_role('dialog',name='Verify your authenticator',exact=True)
    key=confirm.get_by_role('textbox',name='Authenticator setup key',exact=True).input_value()
    confirm.get_by_role('textbox',name='Security verification code',exact=True).fill('wrong-code')
    confirm.get_by_role('button',name='Verify & enable',exact=True).click()
    expect(confirm.get_by_role('alert')).to_be_visible()
    confirm.get_by_role('textbox',name='Security verification code',exact=True).fill(totp(key))
    confirm.get_by_role('button',name='Verify & enable',exact=True).click()
    recovery=page.get_by_role('dialog',name='Save your recovery codes',exact=True)
    codes=recovery.get_by_label('Recovery codes',exact=True).inner_text().splitlines();assert len(codes)==10
    recovery.get_by_role('button',name='I have saved these codes',exact=True).click()
    expect(page.get_by_text('Two-factor enabled',exact=True)).to_be_visible()
    passed('authenticator QR enrollment, invalid-code recovery and one-time recovery code presentation work')
    page.get_by_role('button',name='Leads',exact=True).click()
    page.get_by_role('textbox',name='Search leads',exact=True).fill('Management buyer')
    expect(page.locator('.leads-table tbody tr')).to_have_count(2)
    page.get_by_role('button',name='Save current view',exact=True).click()
    view=page.get_by_role('dialog',name='Save lead view',exact=True)
    view.get_by_role('textbox',name='Saved view name',exact=True).fill('Daily buyer review')
    view.get_by_role('checkbox',name='Share with the workspace',exact=True).check()
    view.get_by_role('button',name='Save view',exact=True).click()
    expect(view).to_have_count(0)
    viewid=api('GET','/saved-views')[0]['id']
    page.reload()
    expect(page.locator('.leads-table tbody tr')).to_have_count(2)
    page.get_by_role('textbox',name='Search leads',exact=True).fill('No matching contact')
    expect(page.locator('.leads-table tbody tr')).to_have_count(0)
    page.get_by_role('combobox',name='Saved lead view',exact=True).select_option(viewid)
    expect(page.locator('.leads-table tbody tr')).to_have_count(2)
    passed('saved workspace lead views survive reloads and restore the real query')
    agentctx=browser.new_context(viewport={'width':1440,'height':1050},timezone_id='Asia/Dubai')
    assert agentctx.request.post(BASE+'/api/v1/auth/login',data={'workspace':slug,'email':'agent@company.test','password':password}).ok
    apage=agentctx.new_page();apage.set_default_timeout(10000);apage.on('pageerror',lambda e:errors.append(str(e)))
    apage.goto(BASE+'/#/leads')
    apage.get_by_role('combobox',name='Saved lead view',exact=True).select_option(viewid)
    expect(apage.locator('.leads-table tbody tr')).to_have_count(1)
    expect(apage.get_by_role('button',name='Open Management buyer private',exact=True)).to_have_count(0)
    api('POST','/leads/'+agentlead['id']+'/calls',{'direction':'outbound','outcome':'connected','durationSec':120},agentctx)
    passed('shared views preserve agent ownership and never reveal another agent’s buyer')
    page.get_by_role('button',name='Reports',exact=True).click()
    expect(page.get_by_role('heading',name='Reports',exact=True)).to_be_visible()
    expect(page.get_by_role('table')).to_contain_text('Website')
    page.get_by_role('button',name='Call activity',exact=True).click()
    row=page.get_by_role('row').filter(has_text='Daily Agent')
    expect(row).to_contain_text('2 min')
    with page.expect_download() as event:page.get_by_role('button',name='Export report',exact=True).click()
    rows=list(csv.reader(io.StringIO(Path(event.value.path()).read_text(encoding='utf-8-sig'))));assert any(row[0]=='Daily Agent' and row[-1]=='120' for row in rows[1:])
    page.screenshot(path=str(OUT/'management-reports.png'),full_page=True)
    passed('management reports show real call activity and export the filtered data')
    secret=api('POST','/settings/intake-secret/reveal',{})['secret']
    def deliver(event_id,phone):
        raw=json.dumps({'event_id':event_id,'contact':{'name':'Portal comparison buyer','phone':phone},'listing':{'reference':'COMPANY-UI-BAYUT'}},separators=(',',':'))
        timestamp=str(int(time.time()));sig='sha256='+hmac.new(secret.encode(),(timestamp+'.bayut.'+raw).encode(),hashlib.sha256).hexdigest()
        return ctx.request.post(BASE+'/api/v1/intake/portal?source=bayut',data=raw,headers={'content-type':'application/json','x-leadvolt-workspace':slug,'x-leadvolt-timestamp':timestamp,'x-leadvolt-signature':sig})
    assert deliver('company-ui-received','+971506001003').status==201
    assert deliver('company-ui-rejected','not-a-phone').status==400
    page.get_by_role('button',name='Operations',exact=True).click()
    page.get_by_role('button',name='Reconcile portal leads',exact=True).click()
    page.get_by_label('Portal enquiry CSV',exact=True).set_input_files({'name':'fictional-portal.csv','mimeType':'text/csv','buffer':b'event_id,name\r\ncompany-ui-received,LOCAL_ONLY_CONTACT\r\ncompany-ui-rejected,LOCAL_ONLY_CONTACT\r\ncompany-ui-missing,LOCAL_ONLY_CONTACT\r\ncompany-ui-received,LOCAL_ONLY_CONTACT\r\n'})
    with page.expect_request('**/api/v1/reconciliation') as submitted:
        page.get_by_role('button',name='Compare 4 IDs',exact=True).click()
    assert 'LOCAL_ONLY_CONTACT' not in submitted.value.post_data
    expect(page.get_by_role('heading',name=re.compile('Comparison snapshot'))).to_be_visible()
    missing=page.get_by_role('row').filter(has_text='company-ui-missing');expect(missing).to_contain_text('missing')
    expect(page.get_by_role('row').filter(has_text='company-ui-rejected')).to_contain_text('rejected')
    expect(page.get_by_role('row').filter(has_text='company-ui-received')).to_contain_text('received')
    with page.expect_download() as event:page.get_by_role('button',name='Export comparison',exact=True).click()
    rows=list(csv.reader(io.StringIO(Path(event.value.path()).read_text(encoding='utf-8-sig'))));assert len(rows)==4
    page.screenshot(path=str(OUT/'portal-reconciliation.png'),full_page=True)
    passed('CSV reconciliation identifies received, rejected and missing enquiries while submitting only ID fields')
    page.get_by_role('button',name='Account security',exact=True).click()
    page.get_by_role('checkbox',name='agent',exact=True).check()
    page.get_by_role('button',name='Save security policy',exact=True).click()
    policy=page.get_by_role('dialog',name='Confirm workspace security policy',exact=True)
    policy.get_by_role('textbox',name='Current password',exact=True).fill(password)
    policy.get_by_role('textbox',name='Security verification code',exact=True).fill(codes[0])
    policy.get_by_role('button',name='Confirm',exact=True).click()
    expect(policy).to_have_count(0)
    assert agentctx.request.get(BASE+'/api/v1/me').status==401
    assert agentctx.request.post(BASE+'/api/v1/auth/login',data={'workspace':slug,'email':'agent@company.test','password':password}).ok
    apage.reload()
    expect(apage.get_by_role('heading',name='Account security',exact=True)).to_be_visible()
    expect(apage.get_by_text('Your company requires two-factor authentication.',exact=True)).to_be_visible()
    assert agentctx.request.get(BASE+'/api/v1/leads').status==403
    passed('workspace MFA policy revokes unenrolled staff sessions and gates lead access until enrollment')
    apage.get_by_role('button',name='Set up two-factor',exact=True).click()
    modal=apage.get_by_role('dialog',name='Set up two-factor',exact=True)
    modal.get_by_role('textbox',name='Current password',exact=True).fill(password);modal.get_by_role('button',name='Continue',exact=True).click()
    modal=apage.get_by_role('dialog',name='Verify your authenticator',exact=True)
    agentkey=modal.get_by_role('textbox',name='Authenticator setup key',exact=True).input_value()
    modal.get_by_role('textbox',name='Security verification code',exact=True).fill(totp(agentkey));modal.get_by_role('button',name='Verify & enable',exact=True).click()
    apage.get_by_role('button',name='I have saved these codes',exact=True).click()
    apage.get_by_role('button',name='My day',exact=True).click()
    expect(apage.get_by_role('heading',name='My day',exact=True)).to_be_visible()
    assert agentctx.request.get(BASE+'/api/v1/leads').status==200
    passed('required authenticator enrollment restores normal agent workflows')
    signin=browser.new_context(viewport={'width':1440,'height':1050});spage=signin.new_page();spage.set_default_timeout(10000)
    spage.goto(BASE)
    spage.get_by_label('Workspace',exact=True).fill(slug);spage.get_by_label('Email',exact=True).fill('owner@company.test');spage.get_by_label('Password',exact=True).fill(password)
    spage.get_by_role('button',name='Sign in',exact=True).click()
    expect(spage.get_by_role('heading',name='Verify your sign-in',exact=True)).to_be_visible()
    spage.get_by_role('textbox',name='Sign-in verification code',exact=True).fill('bad-code')
    spage.get_by_role('button',name='Verify sign-in',exact=True).click();expect(spage.get_by_role('alert')).to_be_visible()
    spage.get_by_role('textbox',name='Sign-in verification code',exact=True).fill(codes[1])
    spage.get_by_role('button',name='Verify sign-in',exact=True).click()
    expect(spage.get_by_text('Where leads come from',exact=True)).to_be_visible()
    passed('password sign-in requires a second factor and an unused recovery code completes sign-in')
    page.get_by_role('button',name='Refresh sessions',exact=True).click()
    other=page.get_by_role('row').filter(has_text='Other device');expect(other).to_have_count(1)
    other.get_by_role('button',name='Revoke session',exact=True).click()
    expect(other).to_have_count(0);assert signin.request.get(BASE+'/api/v1/me').status==401
    page.screenshot(path=str(OUT/'account-security.png'),full_page=True)
    passed('device session revocation ends only the selected device')
    for name in ['Account security','Reports']:
        page.get_by_role('button',name=name,exact=True).click()
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),name+' overflows'
        page.screenshot(path=str(OUT/(name.lower().replace(' ','-')+'-mobile.png')),full_page=True)
        page.set_viewport_size({'width':1440,'height':1050})
    passed('security and report screens fit a phone viewport')
    assert not errors,errors
    (OUT/'results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'page_errors':errors},indent=2))
    browser.close()
