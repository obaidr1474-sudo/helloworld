import { describe, expect, it } from 'vitest';
import { csvCell, makeCsv } from '../../web/src/lib/csv';

describe('lead CSV export', () => {
  it('quotes commas, quotes and line breaks without losing contact data', () => {
    expect(csvCell('Ahmed, "Buyer"\nDubai')).toBe('"Ahmed, ""Buyer""\nDubai"');
    expect(csvCell(null)).toBe('""');
    expect(makeCsv(['Name'], [['ليلى']])).toBe('\uFEFF"Name"\r\n"ليلى"');
  });

  it('prevents names, phone numbers and whitespace-prefixed input becoming spreadsheet formulas', () => {
    for (const value of ['=1+1', '+971501234567', '-123', '@SUM(1,2)', ' \t=HYPERLINK("https://example.test")']) {
      expect(csvCell(value)).toBe('"\'' + value.replace(/"/g, '""') + '"');
    }
    expect(csvCell('LV-1001')).toBe('"LV-1001"');
  });
});
