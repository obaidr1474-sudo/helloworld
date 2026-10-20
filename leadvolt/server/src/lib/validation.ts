import {z} from 'zod';
const amount=z.number().finite().min(0).max(1e12);
export const requirementsSchema=z.object({
  purpose:z.enum(['buy','rent','invest','']).optional(),offering:z.enum(['ready','off_plan','any']).optional(),
  types:z.array(z.string().trim().max(60)).max(20).optional(),beds:z.number().int().min(0).max(20).nullable().optional(),
  budgetMin:amount.nullable().optional(),budgetMax:amount.nullable().optional(),communities:z.array(z.string().trim().max(160)).max(50).optional(),
}).strict().refine(v=>v.budgetMin==null||v.budgetMax==null||v.budgetMin<=v.budgetMax,{message:'Minimum budget cannot exceed maximum budget.',path:['budgetMin']});
