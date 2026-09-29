import { describe, expect, it } from 'vitest';
import { attachmentPreviewKind, materialTypeLabel, startOfLocalWeek, titleFromFileName } from './attachment-title.js';

describe('titleFromFileName', () => {
  it('drops only the last extension and keeps names that have no stem', () => {
    expect(titleFromFileName('【AI售后助手】2025年9月.docx')).toBe('【AI售后助手】2025年9月');
    expect(titleFromFileName('archive.tar.gz')).toBe('archive.tar');
    expect(titleFromFileName('README')).toBe('README');
    expect(titleFromFileName('.gitignore')).toBe('.gitignore');
    expect(titleFromFileName('  报告. ')).toBe('报告');
    expect(titleFromFileName('   ')).toBe('');
  });
});

describe('materialTypeLabel', () => {
  it('uses the file extension for attachments and the kind name otherwise', () => {
    expect(materialTypeLabel('attachment', '说明.docx')).toBe('DOCX');
    expect(materialTypeLabel('attachment', 'README')).toBe('附件');
    expect(materialTypeLabel('thread')).toBe('会话');
    expect(materialTypeLabel('markdown')).toBe('Markdown');
  });
});

describe('attachmentPreviewKind', () => {
  it('chooses a reader from the file extension', () => {
    expect(attachmentPreviewKind('说明.md')).toBe('markdown');
    expect(attachmentPreviewKind('记录.TXT')).toBe('text');
    expect(attachmentPreviewKind('页面.html')).toBe('html');
    expect(attachmentPreviewKind('说明.pdf')).toBe('pdf');
    expect(attachmentPreviewKind('说明.docx')).toBe('docx');
    expect(attachmentPreviewKind('图.png')).toBe('image');
    expect(attachmentPreviewKind('旧档.doc')).toBe('unsupported');
    expect(attachmentPreviewKind('README')).toBe('unsupported');
  });
});

describe('startOfLocalWeek', () => {
  it('starts on the local Monday', () => {
    expect(startOfLocalWeek(new Date(2026, 8, 29, 15, 30))).toBe(new Date(2026, 8, 28).toISOString());
    expect(startOfLocalWeek(new Date(2026, 8, 27, 1))).toBe(new Date(2026, 8, 21).toISOString());
  });
});
