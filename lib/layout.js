// Formula templates for the job tabs. {r} is replaced by the row number.
// Ranges run to row 1501 (Job Budgets / Jobber Jobs / Job Payouts / Cards) and 20000 (Jobber Time).
export const LAYOUT_VERSION = 'jobs-v2';
export const LAST_ROW = 1501;

const JB = (col) => `'Job Budgets'!$${col}$2:$${col}$1501`;
const bud = (col) => `INDEX(${JB(col)},MATCH(A{r},${JB('A')},0))`;

export const JOBBER_JOBS_FORMULAS = [
  // G qualifying date
  '=IF(A{r}="","",IF(AND(C{r}="Completed",D{r}<>"",F{r}<>""),MAX(D{r},F{r}),""))',
  // H payroll period: only APPROVED jobs get one. Override (Job Budgets G) beats the automatic date rule.
  `=IF(A{r}="","",IF(N{r}<>"Approved","",IF(LEN(IFERROR(${bud('G')},""))>0,IFERROR(${bud('G')},""),IF(G{r}="","",IFERROR(IF(G{r}<=INDEX('Payroll Periods'!$C$2:$C$60,MATCH(G{r},'Payroll Periods'!$B$2:$B$60,1)),INDEX('Payroll Periods'!$A$2:$A$60,MATCH(G{r},'Payroll Periods'!$B$2:$B$60,1)),""),"")))))`,
  // I budget hours
  `=IF(A{r}="","",IFERROR(IF(${bud('C')}="","",${bud('C')}),""))`,
  // J hours logged
  `=IF(A{r}="","",SUMIFS('Jobber Time'!$E$2:$E$20000,'Jobber Time'!$D$2:$D$20000,A{r}))`,
  // K share of budget used
  '=IF(OR(A{r}="",I{r}="",I{r}=0),"",J{r}/I{r})',
  // L flag
  '=IF(A{r}="","",IF(I{r}="","NO BUDGET HOURS",IF(J{r}>I{r},"OVER BUDGET","")))',
  // M period source
  `=IF(A{r}="","",IF(LEN(IFERROR(${bud('G')},""))>0,"OVERRIDE",IF(H{r}<>"","Auto","")))`,
  // N approval (blank = Pending)
  `=IF(A{r}="","",IFERROR(IF(${bud('H')}="","Pending",${bud('H')}),"Pending"))`,
  // O review status
  '=IF(A{r}="","",IF(N{r}="Approved",IF(H{r}="","Approved - NO PERIOD (type an override)","Approved"),IF(N{r}="Hold","On hold",IF(N{r}="Excluded","Excluded",IF(AND(C{r}="Completed",E{r}="Paid"),"Ready for review",IF(C{r}="Completed","Completed - waiting on payment","In progress"))))))',
];

export const JOBBER_JOBS_HEADERS_NO = ['Approval (from Job Budgets)', 'Review Status', 'Invoices', 'Balance Owing ($)', 'Uninvoiced ($)', 'Jobber Job ID', 'Jobber Link'];

export const PAYOUT_FORMULAS = [
  "=IF($A{r}=\"\",\"\",IFERROR(INDEX('Jobber Jobs'!$H$2:$H$1501,MATCH($A{r},'Jobber Jobs'!$A$2:$A$1501,0)),\"\"))",
  "=IF($A{r}=\"\",\"\",IFERROR(IF(INDEX('Job Budgets'!$C$2:$C$1501,MATCH($A{r},'Job Budgets'!$A$2:$A$1501,0))=\"\",\"\",INDEX('Job Budgets'!$C$2:$C$1501,MATCH($A{r},'Job Budgets'!$A$2:$A$1501,0))),\"\"))",
  "=IF($A{r}=\"\",\"\",IF(D{r}=\"\",\"\",D{r}*Settings!$B$4))",
  "=IF($A{r}=\"\",\"\",SUMIFS('Jobber Time'!$E$2:$E$20000,'Jobber Time'!$D$2:$D$20000,$A{r},'Jobber Time'!$G$2:$G$20000,$B{r}))",
  "=IF($A{r}=\"\",\"\",SUMIFS('Jobber Time'!$E$2:$E$20000,'Jobber Time'!$D$2:$D$20000,$A{r}))",
  "=IF($A{r}=\"\",\"\",IF(G{r}=0,0,F{r}/G{r}))",
  "=IF($A{r}=\"\",\"\",IFERROR(INDEX(Employees!$D$2:$D$26,MATCH($B{r},Employees!$A$2:$A$26,0)),0))",
  "=IF($A{r}=\"\",\"\",IF(D{r}=\"\",0,E{r}*H{r}*I{r}))",
  "=IF($A{r}=\"\",\"\",SUMIFS(Cards!$E$2:$E$1501,Cards!$C$2:$C$1501,$A{r},Cards!$B$2:$B$1501,$B{r}))",
  "=IF($A{r}=\"\",\"\",J{r}-K{r})",
  "=IF($A{r}=\"\",\"\",IF(D{r}=\"\",\"NO BUDGET HOURS\",IF(G{r}>D{r},\"OVER BUDGET\",\"\")))"
];

export const BUDGET_D = '=IF(C{r}="","",C{r}*Settings!$B$4)';

export const fill = (f, r) => f.replaceAll('{r}', String(r));
