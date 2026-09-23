import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSnapshotInvariants, markdownToUniver } from './markdown-to-univer.js';

test('empty markdown yields the minimal valid snapshot', () => {
    const doc = markdownToUniver('');
    assert.equal(doc.body!.dataStream, '\r\n');
    assert.equal(doc.body!.paragraphs!.length, 1);
    assert.equal(doc.body!.sectionBreaks!.length, 1);
    assertSnapshotInvariants(doc);
});

test('output is deterministic', () => {
    const md = '# T\n\nHello **world** [x](https://a.b)\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    assert.equal(JSON.stringify(markdownToUniver(md)), JSON.stringify(markdownToUniver(md)));
});

test('structures map to univer tokens', () => {
    const doc = markdownToUniver('# H\n\n> q\n\n```\ncode\n```\n\n| a |\n|---|\n| 1 |\n\n1. one\n');
    const body = doc.body!;
    assertSnapshotInvariants(doc);
    assert.equal(body.blockRanges!.length, 2);
    assert.equal(body.tables!.length, 1);
    assert.ok(Object.keys(doc.tableSource!).length === 1);
    const ordered = body.paragraphs!.find((p) => p.bullet?.listType === 'ORDER_LIST');
    assert.ok(ordered);
    assert.equal(body.paragraphs![0]!.paragraphStyle!.namedStyleType, 4 /* HEADING_1 */);
});

test('invariant checker catches broken paragraphs', () => {
    const doc = markdownToUniver('a');
    doc.body!.paragraphs![0]!.startIndex = 0;
    assert.throws(() => assertSnapshotInvariants(doc));
});
