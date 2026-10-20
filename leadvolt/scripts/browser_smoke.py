"""Browser regression checks. Uses a new fictional workspace on each run.
Run the API and Vite first, then: python scripts/browser_smoke.py
Requires the Python playwright package and Chromium (or CHROMIUM_PATH).
"""
import csv
import io
import json
import os
from pathlib import Path
import re
import shutil
from datetime import datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('LEADVOLT_URL', 'http://127.0.0.1:5173')
OUT = Path(os.environ.get('LEADVOLT_REVIEW_DIR', '/tmp/leadvolt-browser-review'))
OUT.mkdir(parents=True, exist_ok=True)
checks = []

def passed(name):
    checks.append(name)
    print('PASS:', name, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, timezone_id='Asia/Dubai', accept_downloads=True)
    page = context.new_page()
    page.set_default_timeout(10000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    slug = 'browser-review-' + uuid4().hex[:10]
    res = context.request.post(BASE + '/api/v1/auth/register', data={'company':'Browser review (fictional)', 'slug':slug, 'name':'Review Owner', 'email':'review@example.test', 'password':'review-only-123456'})
    assert res.status == 200, res.text()
    token = res.json()['token']
    headers = {'Authorization':'Bearer '+token}
    def api(method, path, body=None):
        r = context.request.fetch(BASE + '/api/v1' + path, method=method, data=body, headers=headers)
        assert r.ok, f'{method} {path}: {r.status} {r.text()}'
        return r.json() if r.status != 204 else None
    agent = api('POST','/users',{'name':'Review Agent','email':'agent@example.test','password':'review-only-123456','role':'agent'})
    leads = []
    for n in range(1,14):
        lead = api('POST','/leads', {'name':f'Review Lead {n:02}', 'phone':f'+9715099{n:05}', 'source':'bayut' if n % 2 else 'facebook', 'ownerId':None, 'requirements':{'budgetMax':1500000}})['lead']
        leads.append(lead)
    page.goto(BASE)
    page.evaluate('(token) => { localStorage.clear(); localStorage.setItem("lv_token", token); }', token)
    page.reload()
    expect(page.get_by_text('Where leads come from',exact=True)).to_be_visible()
    page.get_by_role('button',name=re.compile('Total leads')).click()
    expect(page.get_by_role('button',name='All statuses 13',exact=True)).to_have_attribute('aria-pressed','true')
    expect(page.locator('.leads-table tbody tr')).to_have_count(10)
    passed('dashboard metrics drill through to the matching lead table')
    page.get_by_role('button',name='Next page',exact=True).click()
    expect(page.locator('.leads-table tbody tr')).to_have_count(3)
    page.get_by_role('button',name='Previous page',exact=True).click()
    expect(page.locator('.leads-table tbody tr')).to_have_count(10)
    passed('next and previous pages show all 13 leads')
    page.get_by_role('textbox',name='Search leads',exact=True).fill('Review Lead 01')
    expect(page.locator('.leads-table tbody tr')).to_have_count(1)
    expect(page.get_by_role('button',name='Open Review Lead 01',exact=True)).to_be_visible()
    page.get_by_role('textbox',name='Search leads',exact=True).fill('')
    expect(page.locator('.leads-table tbody tr')).to_have_count(10)
    passed('lead search refreshes rows and filtered counts')
    page.get_by_role('button',name='Filters',exact=True).click()
    page.get_by_label('Source',exact=True).select_option('facebook')
    expect(page.locator('.leads-table tbody tr')).to_have_count(6)
    expect(page.locator('.results-toolbar')).to_contain_text('6 leads in this view')
    page.get_by_label('Created from',exact=True).fill('2035-01-01')
    expect(page.locator('.leads-table tbody tr')).to_have_count(0)
    expect(page.get_by_label('Created from',exact=True)).to_have_value('2035-01-01')
    page.get_by_role('button',name='Clear filters',exact=True).first.click()
    expect(page.locator('.leads-table tbody tr')).to_have_count(10)
    passed('source and local-date filters update results and reset correctly')
    page.get_by_role('button',name='Columns',exact=True).click()
    page.get_by_role('checkbox',name='Budget',exact=True).uncheck()
    expect(page.get_by_role('columnheader',name='Budget',exact=True)).to_have_count(0)
    page.reload()
    expect(page.locator('.leads-table tbody tr')).to_have_count(10)
    expect(page.get_by_role('columnheader',name='Budget',exact=True)).to_have_count(0)
    page.get_by_role('button',name='Columns',exact=True).click()
    page.get_by_role('checkbox',name='Budget',exact=True).check()
    page.get_by_role('button',name='Columns',exact=True).click()
    passed('column visibility persists after a reload')
    with page.expect_download() as download:
        page.get_by_role('button',name='Export CSV',exact=True).click()
    file = download.value
    rows=list(csv.reader(io.StringIO(Path(file.path()).read_text(encoding='utf-8-sig'))))
    assert len(rows)==14, len(rows)
    assert rows[0][0]=='Lead ID'
    assert all(row[2].startswith("'+971") for row in rows[1:])
    passed('CSV exports every matching page with protected phone cells')
    page.locator('.leads-table tbody input[type=checkbox]').nth(0).check()
    page.locator('.leads-table tbody input[type=checkbox]').nth(1).check()
    page.get_by_role('combobox',name='Bulk assign to',exact=True).select_option(agent['id'])
    page.get_by_role('button',name='Assign leads',exact=True).click()
    expect(page.get_by_text('2 leads assigned',exact=True)).to_be_visible()
    assigned=api('GET','/leads?queue=all&ownerId='+agent['id'])
    assert len(assigned['items'])==2
    passed('bulk assignment persists through the real API')
    # Find and update one specific lead regardless of sorting or current pagination.
    page.get_by_role('textbox',name='Search leads',exact=True).fill('Review Lead 01')
    expect(page.locator('.leads-table tbody tr')).to_have_count(1)
    page.get_by_role('button',name='Update status for Review Lead 01',exact=True).click()
    dialog=page.get_by_role('dialog',name='Update status · Review Lead 01',exact=True)
    expect(dialog).to_be_visible()
    dialog.get_by_role('button',name=re.compile('Callback')).click()
    future=(datetime.now(ZoneInfo('Asia/Dubai'))+timedelta(days=2)).strftime('%Y-%m-%dT%H:%M')
    dialog.get_by_label('Next action',exact=True).fill(future)
    dialog.get_by_role('button',name='Save & close',exact=True).click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_text('Saved: Callback',exact=True)).to_be_visible()
    updated=api('GET','/leads/'+leads[0]['id'])
    assert updated['stage']=='contacted'
    tasks=api('GET','/tasks?queue=upcoming&leadId='+leads[0]['id'])
    assert len(tasks)==1 and tasks[0]['status']=='open'
    drawer=page.get_by_role('dialog',name='Lead details: Review Lead 01',exact=True)
    drawer.get_by_role('textbox',name='Note',exact=True).fill('Browser-verified follow-up note')
    drawer.get_by_role('button',name='Add note',exact=True).click()
    expect(drawer.get_by_text('Browser-verified follow-up note',exact=True)).to_be_visible()
    passed('status update schedules a real follow-up and saves a timeline note')
    page.reload()
    expect(page.get_by_role('dialog',name='Lead details: Review Lead 01',exact=True)).to_be_visible()
    passed('lead detail links survive a page reload')
    page.screenshot(path=str(OUT/'lead-detail.png'),full_page=True)
    page.get_by_role('button',name='Close lead details',exact=True).click()
    action=page.locator('.row-actions button[aria-label^="Update status"]').first
    first_name=action.get_attribute('aria-label').removeprefix('Update status for ')
    action.click()
    disposition=page.get_by_role('dialog',name='Update status · '+first_name,exact=True)
    disposition.get_by_role('button',name=re.compile('Callback')).click()
    disposition.get_by_label('Next action',exact=True).fill(future)
    disposition.get_by_role('button',name=re.compile('Save & next')).click()
    expect(disposition).to_have_count(0)
    expect(page.locator('.lead-drawer')).not_to_have_attribute('aria-label','Lead details: '+first_name)
    expect(page.locator('.lead-drawer .whead h2')).to_be_visible()
    page.get_by_role('button',name='Close lead details',exact=True).click()
    passed('Save & next advances the lead drawer through the queue')
    call_action=page.locator('.row-actions button[aria-label^="Log call"]').first
    call_name=call_action.get_attribute('aria-label').removeprefix('Log call for ')
    call_action.click()
    call_dialog=page.get_by_role('dialog',name='Log call · '+call_name,exact=True)
    call_dialog.get_by_role('checkbox',name='Update status next',exact=True).uncheck()
    call_dialog.get_by_role('textbox',name='Summary',exact=True).fill('Browser-verified call log')
    call_dialog.get_by_role('button',name='Save call',exact=True).click()
    expect(call_dialog).to_have_count(0)
    expect(page.get_by_text('Call logged',exact=True)).to_be_visible()
    expect(page.locator('.lead-drawer .timeline')).to_contain_text('Browser-verified call log')
    page.get_by_role('button',name='Close lead details',exact=True).click()
    passed('call logging persists into the lead timeline')
    page.get_by_role('textbox',name='Search all leads',exact=True).fill('Review Lead 02')
    page.get_by_role('textbox',name='Search all leads',exact=True).press('Enter')
    expect(page.locator('.leads-table tbody tr')).to_have_count(1)
    expect(page.get_by_role('button',name='Open Review Lead 02',exact=True)).to_be_visible()
    passed('global search works while already on the leads screen')
    page.get_by_role('button',name='New lead',exact=True).click()
    new=page.get_by_role('dialog',name='New lead',exact=True)
    new.get_by_role('textbox',name='Full name',exact=True).fill('Browser Created Lead')
    new.get_by_role('textbox',name='Phone',exact=True).fill('+971509999999')
    new.get_by_role('button',name='Create lead',exact=True).click()
    expect(page.get_by_role('dialog',name='Lead details: Browser Created Lead',exact=True)).to_be_visible()
    page.get_by_role('button',name='Close lead details',exact=True).click()
    page.get_by_role('button',name='Dashboard',exact=True).click()
    expect(page.get_by_text('Where leads come from',exact=True)).to_be_visible()
    page.get_by_role('button',name='Leads',exact=True).click()
    expect(page.get_by_role('dialog',name='New lead',exact=True)).to_have_count(0)
    passed('new-lead creation persists and its dialog does not reopen on navigation')
    expect(page.get_by_text('Live updates connected',exact=True)).to_be_visible()
    api('POST','/leads',{'name':'Live Browser Lead','phone':'+971509999998','source':'website','ownerId':None})
    expect(page.get_by_role('button',name='Open Live Browser Lead',exact=True)).to_be_visible()
    passed('live events refresh the table without a manual reload')
    for name in ['Properties','Follow-ups','Inbox','Team & rules']:
        page.get_by_role('button',name=name,exact=True).click()
        expect(page.locator('.breadcrumb strong')).to_have_text(name)
    passed('all six workspace modules remain navigable')
    page.get_by_role('button',name='Dashboard',exact=True).click()
    expect(page.get_by_text('Where leads come from',exact=True)).to_be_visible()
    for width,height in [(390,844),(768,1024)]:
        page.set_viewport_size({'width':width,'height':height})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Dashboard overflows viewport'
        profile = page.locator('.profile-menu summary').bounding_box()
        assert profile and profile['x'] + profile['width'] <= width, 'Profile control is clipped on mobile'
        page.screenshot(path=str(OUT/f'dashboard-{width}.png'),full_page=True)
        page.get_by_role('button',name='Leads',exact=True).click()
        expect(page.locator('.leads-table tbody tr')).to_have_count(10)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Leads page overflows viewport'
        page.screenshot(path=str(OUT/f'leads-{width}.png'),full_page=True)
        page.get_by_role('button',name='Open Live Browser Lead',exact=True).click()
        expect(page.get_by_role('dialog',name='Lead details: Live Browser Lead',exact=True)).to_be_visible()
        page.get_by_role('button',name='Close lead details',exact=True).click()
        page.get_by_role('button',name='Dashboard',exact=True).click()
    passed('mobile and tablet layouts, horizontal table scrolling and lead drawer work')
    page.set_viewport_size({'width':1440,'height':1000})
    page.route('**/api/v1/analytics/overview*',lambda route:route.fulfill(status=503,content_type='application/json',body='{"message":"Temporary test outage"}'))
    page.get_by_role('button',name='Refresh dashboard',exact=True).click()
    expect(page.get_by_role('alert')).to_have_text('Temporary test outage')
    page.unroute('**/api/v1/analytics/overview*')
    page.get_by_role('button',name='Try again',exact=True).click()
    expect(page.get_by_text('Where leads come from',exact=True)).to_be_visible()
    passed('dashboard errors are visible and recover through retry')
    assert not errors, errors
    passed('no uncaught browser JavaScript errors')
    (OUT/'results.json').write_text(json.dumps({'checks':checks,'passed':len(checks),'page_errors':errors},indent=2))
    browser.close()
    print(json.dumps({'passed':len(checks),'output':str(OUT)}),flush=True)
