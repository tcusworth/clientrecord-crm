// Prefix text cells that a spreadsheet would treat as a formula (CSV/formula injection); numbers stay numeric.
export function csvCell(value:unknown){const raw=value==null?"":String(value),text=typeof value!=="number"&&/^[=+\-@\t\r]/.test(raw)?`'${raw}`:raw;return /[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}
