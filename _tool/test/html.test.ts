import { describe, it, expect } from 'vitest';
import { buildHtml, scriptJson } from '../src/build/html.js';
import { makeModel } from './helpers.js';

const LS = new RegExp('[\\u2028\\u2029]');
const HOSTILE = 'CRM <!--<script> </script> <img src=x onerror=alert(1)> "\'     end';

describe('embedded data block', () => {
  it('scriptJson escapes every < and U+2028/U+2029 and round-trips', () => {
    expect(LS.test(HOSTILE)).toBe(true);
    const s = scriptJson({ name: HOSTILE });
    expect(s).not.toContain('<');
    expect(LS.test(s)).toBe(false);
    expect(JSON.parse(s)).toEqual({ name: HOSTILE });
  });
  it('buildHtml: no raw < inside the data block', async () => {
    const model = makeModel({ products: [{ code: 'crm', name: HOSTILE, team: 't', owners: [], links: [] } as never] });
    const html = await buildHtml({ model, findings: [], builtAt: HOSTILE });
    const m = /<script id="arch-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain('<');
    expect(LS.test(m![1]!)).toBe(false);
    expect(JSON.parse(m![1]!).model.products[0].name).toBe(HOSTILE);
  });
});
