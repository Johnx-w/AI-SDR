import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectAcquisitionEvidence } from '../server/acquisition-evidence-selection.mjs';
import { boundedResearchPages } from '../server/research-input.mjs';
import { researchPageText } from '../server/research-pages.mjs';
import { compactResearchText, researchEvidencePages } from '../server/research-text.mjs';

// Literal annotations were recorded against the HTML before calling either selector.
const examples = [
  {
    id: 'canyon.example.org',
    heading: 'Original equipment and distribution',
    facts: [
      'Canyon Shade LLC is the legal operator.',
      'We manufacture complete roller shades in Nevada for residential windows.',
      'We also distribute a third-party motor range.',
      'We do not purchase curtain fabric.',
    ],
  },
  {
    id: 'harbour.example.org',
    heading: 'Commercial projects',
    facts: [
      'This site is operated by Harbour Curtains Pty Ltd.',
      'We supply custom hotel drapery and quote complete installations.',
      'No products are sold for stage use.',
    ],
  },
  {
    id: 'directory.example.org',
    heading: 'About the listed exhibitor',
    facts: [
      'The website acts as a mere venue.',
      'Coastline Parts is a listed exhibitor and not the operator.',
      'It manufactures curtain-track brackets and sells no finished blinds.',
    ],
  },
];

function irrelevantSections(section) {
  return Array.from(
    { length: 140 },
    (_, i) =>
      '<p>Journal edition ' +
      (i + 1) +
      ' from ' +
      section +
      '. Each issue discusses local trails, public transport, community gardening, holiday trips and local theatre.</p>',
  ).join('');
}

test('the evidence input keeps independently annotated middle-page facts and their attribution under the production budget', () => {
  for (const { id, heading, facts } of examples) {
    const source_url = 'https://' + id + '/';
    const original =
      '<article>' +
      irrelevantSections('January') +
      '<h2>' +
      heading +
      '</h2>' +
      facts.map((fact) => '<p>' + fact + '</p>').join('') +
      irrelevantSections('September') +
      '</article>';
    const text = researchPageText(original, original.length);
    const baseline = boundedResearchPages([
      { source_url, text: compactResearchText(text, source_url) },
    ]);
    const selection = boundedResearchPages([selectAcquisitionEvidence(source_url, original)]);
    assert.ok(
      facts.every((fact) => !baseline.pages[0].text.includes(fact)),
      id,
    );
    const spans = researchEvidencePages(selection.pages);
    assert.ok(selection.stats.inputChars <= 16000);
    assert.ok(
      spans.some(
        (span) => span.text.includes(heading) && facts.every((fact) => span.text.includes(fact)),
      ),
      id,
    );
    for (const fact of facts) assert.ok(original.indexOf(fact) > 0, fact);
    assert.equal(selection.pages[0].source_url, source_url);
  }
});
