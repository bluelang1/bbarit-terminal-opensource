/**
 * OrganizeNoteModal.tsx
 *
 * AI-powered note organizer modal.
 * Takes raw text input and produces a structured markdown note
 * with tags, wikilinks, title, and section headings.
 *
 * Uses NoteContext hooks internally (must be rendered inside NoteProvider).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { OctoX } from '../octoIcons';
import { Send, FolderOpen, ChevronDown } from 'lucide-react';
import { organizeNote, getAiTagProvider, AI_TAG_PROVIDERS, setAiTagProvider, type AiTagProvider, type OrganizeNoteResult } from './ollamaTagging';
import { useNoteState, useGlobalNotesDir, useRequestReindex } from './NoteContext';
import { useTranslation } from '../i18n';
import './OrganizeNoteModal.css';

interface OrganizeNoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNoteCreated: (path: string) => void;
  /** When provided, skip input step and organize this content directly */
  sourceContent?: string;
  /** Path of the source file — save overwrites this file */
  sourceFilePath?: string;
}

type Step = 'input' | 'loading' | 'preview';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s가-힣ぁ-んァ-ヶ一-龥a-zA-Z0-9-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled';
}

export default function OrganizeNoteModal({
  isOpen,
  onClose,
  onNoteCreated,
  sourceContent,
  sourceFilePath,
}: OrganizeNoteModalProps) {
  const { t } = useTranslation();
  const noteState = useNoteState();
  const globalNotesDir = useGlobalNotesDir();
  const requestReindex = useRequestReindex();

  const [step, setStep] = useState<Step>('input');
  const [rawText, setRawText] = useState('');
  const [result, setResult] = useState<OrganizeNoteResult | null>(null);
  const [editedContent, setEditedContent] = useState('');
  const [selectedFolder, setSelectedFolder] = useState('');
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const [provider, setProvider] = useState<AiTagProvider>('ollama');
  const [saving, setSaving] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLTextAreaElement>(null);

  // Derive folder list from noteIndex paths
  const folders = useMemo(() => {
    if (!globalNotesDir) return [];
    const folderSet = new Set<string>();
    for (const entry of noteState.noteIndex) {
      if (!entry.path.startsWith(globalNotesDir)) continue;
      const rel = entry.path.slice(globalNotesDir.length + 1);
      const parts = rel.split('/');
      if (parts.length > 1) {
        // Add the first directory segment
        folderSet.add(parts[0]);
      }
    }
    return Array.from(folderSet).sort();
  }, [noteState.noteIndex, globalNotesDir]);

  const handleOrganize = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setStep('loading');
    setError('');

    try {
      const existingTags = noteState.tagIndex.map(t => t.tag);
      const noteNames = noteState.noteIndex.map(n => n.name);

      const res = await organizeNote(trimmed, existingTags, noteNames, folders);
      setResult(res);
      setEditedContent(res.content);
      setSelectedFolder(res.folder || '');
      setStep('preview');
      setTimeout(() => previewRef.current?.focus(), 50);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStep(sourceContent ? 'input' : 'input');
    }
  }, [noteState.tagIndex, noteState.noteIndex, folders, sourceContent]);

  // Reset on open & auto-start if sourceContent provided
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setRawText(sourceContent || '');
      setResult(null);
      setEditedContent('');
      setSelectedFolder('');
      setError('');
      setClosing(false);
      setSaving(false);
      getAiTagProvider().then(p => setProvider(p)).catch(() => {});

      if (sourceContent?.trim()) {
        // Auto-start organizing with the file content
        setStep('loading');
        void handleOrganize(sourceContent);
      } else {
        setStep('input');
        setTimeout(() => textareaRef.current?.focus(), 100);
      }
    }
    prevOpenRef.current = isOpen;
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    if (!result || saving) return;

    setSaving(true);
    try {
      let filePath: string;

      if (sourceFilePath) {
        // Overwrite existing file
        filePath = sourceFilePath;
      } else {
        // Create new file
        if (!globalNotesDir) { setSaving(false); return; }
        let saveDir = globalNotesDir;
        if (selectedFolder) {
          saveDir = `${globalNotesDir}/${selectedFolder}`;
          await invoke('create_directory', { path: saveDir }).catch(() => {});
        }

        const slug = slugify(result.title);
        const fileName = `${slug}.md`;
        filePath = `${saveDir}/${fileName}`;

        // Check for existing file
        try {
          await invoke<string>('read_file', { path: filePath });
          const suffix = Date.now().toString(36);
          filePath = `${saveDir}/${slug}-${suffix}.md`;
        } catch {
          // File doesn't exist, use original
        }
      }

      await invoke('write_file', { path: filePath, content: editedContent });

      // Trigger reindex so graph view updates
      requestReindex();

      onNoteCreated(filePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  }, [result, globalNotesDir, selectedFolder, editedContent, saving, onNoteCreated, requestReindex]);

  const handleClose = useCallback(() => {
    if (step === 'loading') return;
    setClosing(true);
    setTimeout(() => onClose(), 180);
  }, [step, onClose]);

  const handleProviderChange = useCallback((p: AiTagProvider) => {
    setProvider(p);
    setAiTagProvider(p);
  }, []);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  return (
    <div
      className={`orgn-overlay ${closing ? 'closing' : ''}`}
      onMouseDown={e => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="orgn-modal">
        {/* Header */}
        <div className="orgn-header">
          <span className="orgn-header-icon">&#x2728;</span>
          <span className="orgn-header-title">{t('notes.organize.title')}</span>
          <div className="orgn-provider-select">
            {AI_TAG_PROVIDERS.map(p => (
              <button
                key={p.id}
                className={`orgn-provider-btn ${provider === p.id ? 'active' : ''}`}
                onClick={() => handleProviderChange(p.id)}
                title={p.description}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button className="orgn-header-close" onClick={handleClose} title={t('common.close')}>
            <OctoX size={14} />
          </button>
        </div>

        {/* Input Step */}
        {step === 'input' && (
          <div className="orgn-input-step">
            <div className="orgn-input-hint">
              {t('notes.organize.desc')}
            </div>
            <textarea
              ref={textareaRef}
              className="orgn-textarea"
              placeholder={t('notes.organize.placeholder')}
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                  void handleOrganize(rawText);
                }
              }}
            />
            {error && <div className="orgn-error">{error}</div>}
            <div className="orgn-input-actions">
              <span className="orgn-shortcut-hint">{navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter</span>
              <button
                className="orgn-organize-btn"
                onClick={() => void handleOrganize(rawText)}
                disabled={!rawText.trim()}
              >
                <Send size={14} />
                {t('notes.organize.process')}
              </button>
            </div>
          </div>
        )}

        {/* Loading Step */}
        {step === 'loading' && (
          <div className="orgn-loading-step">
            <span className="orgn-spinner" />
            <span>{t('notes.organize.processing')}</span>
          </div>
        )}

        {/* Preview Step */}
        {step === 'preview' && result && (
          <div className="orgn-preview-step">
            {/* Meta info */}
            <div className="orgn-meta">
              <div className="orgn-meta-row">
                <span className="orgn-meta-label">{t('notes.organize.titleLabel')}</span>
                <span className="orgn-meta-value">{result.title}</span>
              </div>
              <div className="orgn-meta-row">
                <span className="orgn-meta-label">{t('notes.organize.tags')}</span>
                <div className="orgn-tag-list">
                  {result.tags.map(t => (
                    <span key={t} className="orgn-tag-chip">#{t}</span>
                  ))}
                </div>
              </div>
              {result.links.length > 0 && (
                <div className="orgn-meta-row">
                  <span className="orgn-meta-label">{t('notes.organize.links')}</span>
                  <div className="orgn-link-list">
                    {result.links.map(l => (
                      <span key={l} className="orgn-link-chip">[[{l}]]</span>
                    ))}
                  </div>
                </div>
              )}
              {sourceFilePath ? (
                <div className="orgn-meta-row">
                  <span className="orgn-meta-label">{t('notes.organize.file')}</span>
                  <span className="orgn-meta-value">{sourceFilePath.split('/').pop()}</span>
                </div>
              ) : (
                <div className="orgn-meta-row">
                  <span className="orgn-meta-label">{t('notes.organize.folder')}</span>
                  <div className="orgn-folder-select-wrap">
                    <FolderOpen size={12} />
                    <select
                      className="orgn-folder-select"
                      value={selectedFolder}
                      onChange={e => setSelectedFolder(e.target.value)}
                    >
                      <option value="">{t('notes.organize.root')}</option>
                      {folders.map(f => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                    <ChevronDown size={10} className="orgn-folder-chevron" />
                  </div>
                </div>
              )}
            </div>

            {/* Editable preview */}
            <textarea
              ref={previewRef}
              className="orgn-preview-textarea"
              value={editedContent}
              onChange={e => setEditedContent(e.target.value)}
            />

            {error && <div className="orgn-error">{error}</div>}

            <div className="orgn-preview-actions">
              <button
                className="orgn-back-btn"
                onClick={() => { setStep('input'); setError(''); }}
              >
                {t('notes.organize.retry')}
              </button>
              <button
                className="orgn-save-btn"
                onClick={() => void handleSave()}
                disabled={saving || !editedContent.trim()}
              >
                {saving ? t('notes.organize.saving') : sourceFilePath ? t('notes.organize.overwrite') : t('notes.organize.save')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
