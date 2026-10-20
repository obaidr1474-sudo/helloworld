/** RFC 4180 style records. Parse locally; only selected IDs are sent to the server. */
export function parseCsv(text:string):string[][]{
 const rows:string[][]=[];let row:string[]=[],value='',quoted=false,closed=false;
 text=text.replace(/^\uFEFF/,'');
 const cell=()=>{row.push(value);value='';closed=false;};
 const record=()=>{cell();if(row.some(c=>c.trim()))rows.push(row);row=[];};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c;continue;}
  if(c==='"'){if(value||closed)throw new Error('Malformed CSV quote.');quoted=true;continue;}
  if(c===','){cell();continue;}
  if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;record();continue;}
  if(closed&&c!==' '&&c!=='\t')throw new Error('Unexpected text after a quoted CSV field.');
  if(!closed)value+=c;
 }
 if(quoted)throw new Error('The CSV contains an unclosed quoted field.');
 if(value||row.length||closed)record();
 return rows;
}
