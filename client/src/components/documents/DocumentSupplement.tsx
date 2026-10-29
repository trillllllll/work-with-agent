import { useTranslation } from 'react-i18next';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { TextDocumentEditor } from './TextDocumentEditor.js';

/** Legacy notes are separate from the authoritative uploaded body and remain readable. */
export function DocumentSupplement({ content, viewKey }: { content?: string | null; viewKey: string }) {
  const { t } = useTranslation('library');
  if (!content) return null;
  return <Disclosure open className="document-info-section" data-testid="document-supplement">
    <DisclosureTrigger>{t('document.supplemental')}</DisclosureTrigger>
    <p className="library-meta">{t('document.supplementalHint')}</p>
    <TextDocumentEditor value={content} viewKey={`${viewKey}:supplement`} format="text" mode="read" readOnly onChange={() => {}} onCompositionChange={() => {}} onUndo={() => {}} onRedo={() => {}} />
  </Disclosure>;
}
