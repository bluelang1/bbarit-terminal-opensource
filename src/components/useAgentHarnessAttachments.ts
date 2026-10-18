import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ClipboardEvent, Dispatch, DragEvent, SetStateAction } from 'react';
import type { Attachment } from '../harness/panelTypes';
import { persistWorkspaceAttachment } from '../harness/attachmentRuntime';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

interface UseAgentHarnessAttachmentsParams {
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  genId: () => string;
  workDir: string;
  onAttachmentAdded?: () => void;
  onAttachmentError?: (message: string) => void;
}

export function useAgentHarnessAttachments(params: UseAgentHarnessAttachmentsParams) {
  const getImageMimeType = useCallback((name: string) => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    return 'image/png';
  }, []);

  const persistAndAddAttachment = useCallback(async (attachment: Attachment): Promise<boolean> => {
    try {
      await persistWorkspaceAttachment(attachment, params.workDir);
      params.setAttachments((prev) => [...prev, attachment]);
      requestAnimationFrame(() => params.onAttachmentAdded?.());
      return true;
    } catch (error) {
      params.onAttachmentError?.(`첨부 파일을 모션 폴더에 복사하지 못했습니다: ${String(error)}`);
      return false;
    }
  }, [params]);

  const addImageAttachment = useCallback(async (
    name: string,
    mimeType: string,
    dataUrl: string,
    size: number,
  ): Promise<boolean> => persistAndAddAttachment({
    id: params.genId(),
    name,
    type: 'image',
    mimeType,
    dataUrl,
    size,
  }), [params, persistAndAddAttachment]);

  const addImageBlobAttachment = useCallback(async (
    blob: Blob,
    name = `paste-${Date.now()}.png`,
  ): Promise<boolean> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('cannot read image'));
      reader.readAsDataURL(blob);
    }).catch(() => '');
    if (!dataUrl) return false;
    return addImageAttachment(name, blob.type || 'image/png', dataUrl, blob.size);
  }, [addImageAttachment]);

  const handleAttachFile = useCallback(async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: 'All',
          extensions: [
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'md', 'ts', 'tsx', 'js',
            'json', 'py', 'rs', 'go', 'css', 'html', 'csv', 'yaml', 'yml', 'toml',
          ],
        },
      ],
    });
    if (!selected) return;

    const paths = Array.isArray(selected) ? selected : [selected];
    for (const selection of paths) {
      const path = typeof selection === 'string'
        ? selection
        : (selection as { path?: string }).path ?? String(selection);
      const name = path.split('/').pop() || 'file';
      const ext = name.split('.').pop()?.toLowerCase() || '';

      if (IMAGE_EXTENSIONS.includes(ext)) {
        const base64 = await invoke<string>('read_file_base64', { path });
        const mimeType = getImageMimeType(name);
        await addImageAttachment(name, mimeType, `data:${mimeType};base64,${base64}`, base64.length);
        continue;
      }

      const content = await invoke<string>('read_file', { path });
      await persistAndAddAttachment({
        id: params.genId(),
        name,
        type: 'text',
        mimeType: 'text/plain',
        dataUrl: content,
        size: content.length,
      });
    }
  }, [addImageAttachment, getImageMimeType, params, persistAndAddAttachment]);

  const handleCaptureImageAttachment = useCallback(async (): Promise<boolean> => {
    const path = await invoke<string>('capture_screenshot');
    if (!path) return false;

    const name = path.split('/').pop() || `capture-${Date.now()}.png`;
    const mimeType = getImageMimeType(name);
    const base64 = await invoke<string>('read_file_base64', { path });
    return addImageAttachment(name, mimeType, `data:${mimeType};base64,${base64}`, base64.length);
  }, [addImageAttachment, getImageMimeType]);

  const handlePasteAttachment = useCallback((event: ClipboardEvent) => {
    if (event.defaultPrevented) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (!item.type.startsWith('image/')) continue;

      event.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;

      void addImageBlobAttachment(blob, `paste-${Date.now()}.png`);
    }
  }, [addImageBlobAttachment]);

  const handlePasteImageFromClipboard = useCallback(async (): Promise<boolean> => {
    try {
      const clipboard = navigator.clipboard as Clipboard & { read?: () => Promise<ClipboardItem[]> };
      const items = clipboard.read ? await clipboard.read() : [];
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        return await addImageBlobAttachment(blob, `clipboard-${Date.now()}.png`);
      }
    } catch {
      // Continue to Tauri/Rust fallbacks below.
    }

    try {
      const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
      const image = await readImage();
      const [size, rgba] = await Promise.all([image.size(), image.rgba()]);
      if (!size?.width || !size?.height || !rgba?.byteLength) return false;

      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;

      const pixels = new Uint8ClampedArray(rgba.byteLength);
      pixels.set(rgba);
      ctx.putImageData(new ImageData(pixels, size.width, size.height), 0, 0);
      return await addImageAttachment(
        `clipboard-${Date.now()}.png`,
        'image/png',
        canvas.toDataURL('image/png'),
        rgba.byteLength,
      );
    } catch {
      // Continue to Rust-side clipboard fallback.
    }

    try {
      const path = await invoke<string>('save_clipboard_image_from_system_clipboard');
      const base64 = await invoke<string>('read_file_base64', { path });
      return await addImageAttachment(
        path.split('/').pop() || `clipboard-${Date.now()}.png`,
        'image/png',
        `data:image/png;base64,${base64}`,
        base64.length,
      );
    } catch {
      return false;
    }
  }, [addImageAttachment, addImageBlobAttachment]);

  const handleDropAttachment = useCallback(async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        await addImageBlobAttachment(file, file.name);
        continue;
      }

      await persistAndAddAttachment({
        id: params.genId(),
        name: file.name,
        type: 'text',
        mimeType: file.type || 'text/plain',
        dataUrl: await file.text(),
        size: file.size,
      });
    }
  }, [addImageBlobAttachment, params, persistAndAddAttachment]);

  const removeAttachment = useCallback((id: string) => {
    params.setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, [params]);

  return {
    handleAttachFile,
    handleCaptureImageAttachment,
    handlePasteAttachment,
    handlePasteImageFromClipboard,
    handleDropAttachment,
    removeAttachment,
  };
}
