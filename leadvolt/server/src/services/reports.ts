import type {Tx} from '../lib/db.js';
import type {Actor} from './leads.js';
export async function managementReport(tx:Tx,actor:Actor,p:{from:string;to:string;agentId?:string;source?:string}){
 const v=[actor.tenantId,p.from,p.to,p.agentId??null,p.source??null];
 const scope=`l.tenant_id=$1 AND l.deleted_at IS NULL AND ($4::uuid IS NULL OR l.owner_id=$4) AND ($5::text IS NULL OR l.source=$5)`;
 const cohort=scope+' AND l.created_at>=$2::timestamptz AND l.created_at<$3::timestamptz';
 const totals=(await tx.query(`SELECT count(*)::int AS leads_created,count(*) FILTER(WHERE l.owner_id IS NULL)::int AS unassigned,
 count(*) FILTER(WHERE l.stage='booked')::int AS booked,count(*) FILTER(WHERE l.stage='lost')::int AS lost,
 count(*) FILTER(WHERE l.first_response_at IS NOT NULL)::int AS responded,
 count(*) FILTER(WHERE l.first_response_at IS NOT NULL AND l.first_response_at<=l.sla_due_at)::int AS responded_within_sla,
 count(*) FILTER(WHERE l.first_response_at IS NULL AND l.sla_due_at<now())::int AS awaiting_overdue_response,
 percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM l.first_response_at-l.created_at)) FILTER(WHERE l.first_response_at IS NOT NULL) AS median_response_sec,
 percentile_cont(0.9) WITHIN GROUP(ORDER BY extract(epoch FROM l.first_response_at-l.created_at)) FILTER(WHERE l.first_response_at IS NOT NULL) AS p90_response_sec
 FROM leads l WHERE ${cohort}`,v)).rows[0];
 const sources=(await tx.query(`SELECT l.source,count(*)::int AS leads,count(*) FILTER(WHERE l.owner_id IS NULL)::int AS unassigned,
 count(*) FILTER(WHERE l.stage='booked')::int AS booked,count(*) FILTER(WHERE l.first_response_at IS NOT NULL AND l.first_response_at<=l.sla_due_at)::int AS within_sla,
 COALESCE(sum(l.deal_value) FILTER(WHERE l.stage='booked'),0)::float AS booked_value FROM leads l WHERE ${cohort} GROUP BY l.source ORDER BY leads DESC,l.source`,v)).rows;
 const agents=(await tx.query(`SELECT u.id,u.full_name,count(l.id)::int AS leads,count(l.id) FILTER(WHERE l.stage='booked')::int AS booked,
 count(l.id) FILTER(WHERE l.stage NOT IN('booked','lost') AND l.next_action_at<now())::int AS overdue,
 count(l.id) FILTER(WHERE l.stage NOT IN('booked','lost') AND (l.last_agent_update_at IS NULL OR l.last_agent_update_at<(date_trunc('day',now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone)))::int AS needs_daily_update,
 COALESCE(sum(l.deal_value) FILTER(WHERE l.stage='booked'),0)::float AS booked_value
 FROM users u JOIN tenants t ON t.id=u.tenant_id LEFT JOIN leads l ON l.tenant_id=u.tenant_id AND l.owner_id=u.id AND ${cohort}
 WHERE u.tenant_id=$1 AND u.role IN('owner','admin','manager','agent') AND ($4::uuid IS NULL OR u.id=$4) GROUP BY u.id,t.timezone ORDER BY booked_value DESC,u.full_name`,v)).rows;
 const stages=(await tx.query(`SELECT l.stage,count(*)::int AS leads,round(avg(extract(epoch FROM now()-l.stage_entered_at)/86400)::numeric,1)::float AS average_days,
 max(extract(epoch FROM now()-l.stage_entered_at)/86400)::float AS oldest_days,count(*) FILTER(WHERE l.stage_entered_at<now()-interval '7 days')::int AS over_seven_days,
 count(*) FILTER(WHERE l.stage_age_estimated)::int AS estimated_history FROM leads l WHERE ${scope} AND l.stage NOT IN('booked','lost') AND $2::timestamptz<$3::timestamptz GROUP BY l.stage ORDER BY average_days DESC`,v)).rows;
 const calls=(await tx.query(`SELECT u.id,u.full_name,count(i.id)::int AS total_calls,
 count(i.id) FILTER(WHERE i.payload->>'outcome'='connected')::int AS connected,
 count(i.id) FILTER(WHERE i.direction='outbound')::int AS outbound,
 count(i.id) FILTER(WHERE i.direction='inbound')::int AS inbound,
 COALESCE(sum(COALESCE((i.payload->>'duration_sec')::int,0)),0)::int AS duration_sec
 FROM users u LEFT JOIN interactions i ON i.tenant_id=u.tenant_id AND i.user_id=u.id AND i.type='call' AND i.occurred_at>=$2::timestamptz AND i.occurred_at<$3::timestamptz
 AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM leads l WHERE l.tenant_id=i.tenant_id AND l.id=i.lead_id AND l.source=$5))
 WHERE u.tenant_id=$1 AND u.role IN('owner','admin','manager','agent') AND ($4::uuid IS NULL OR u.id=$4) GROUP BY u.id ORDER BY total_calls DESC,u.full_name`,v)).rows;
 const bookings=(await tx.query(`SELECT count(*)::int AS bookings,COALESCE(sum(d.deal_value),0)::float AS booked_value,
 count(*) FILTER(WHERE d.status='pending_approval')::int AS pending_approval,
 COALESCE(sum(d.brokerage_amount) FILTER(WHERE d.status IN('approved','invoiced','paid')),0)::float AS approved_brokerage,
 COALESCE(sum(d.brokerage_amount) FILTER(WHERE d.status='paid'),0)::float AS paid_brokerage
 FROM deals d JOIN leads l ON l.tenant_id=d.tenant_id AND l.id=d.lead_id WHERE d.tenant_id=$1 AND d.voided_at IS NULL AND d.status<>'cancelled'
 AND d.booked_at>=$2::timestamptz AND d.booked_at<$3::timestamptz AND ($4::uuid IS NULL OR d.agent_id=$4) AND ($5::text IS NULL OR l.source=$5)`,v)).rows[0];
 return {period:{from:p.from,to:p.to},totals,sources,agents,stages,calls,bookings,definitions:{leads:'Leads created during the selected period, grouped by current owner and current stage.',calls:'Calls logged during the selected period, attributed to the person who logged the call.',bookings:'Current values and approval/payment states of non-voided bookings made during the period. Paid brokerage is not cash received during the period.',stages:'Current active pipeline, regardless of creation period. Legacy stage-entry dates may be estimated and are labelled.'}};
}
