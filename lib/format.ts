const usd=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0});

/** String form of an unknown API value ("" for null/undefined). */
export const text=(value:unknown)=>String(value??"");
/** Whole-dollar USD from an integer cent amount. */
export const money=(cents:unknown)=>usd.format(Number(cents||0)/100);
/** YYYY-MM-DD for the given moment in the viewer's local timezone. */
export const localIsoDate=(date=new Date())=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
