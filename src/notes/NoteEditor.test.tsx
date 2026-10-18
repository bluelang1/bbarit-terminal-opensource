import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NoteEditor } from './NoteEditor';

const baseProps = {
  onChange: vi.fn(),
  style: { bg: '#111111', text: '#eeeeee', accent: '#44cc88' },
  fontFamily: 'monospace',
  fontSize: 14,
  isLightTheme: false,
  getNoteList: () => [],
  noteIndex: [],
};

describe('NoteEditor link navigation', () => {
  it('fires callback when clicking a wikilink', async () => {
    const onWikiLinkClick = vi.fn();
    render(
      <NoteEditor
        {...baseProps}
        content={'See [[overview]] for the summary.'}
        onWikiLinkClick={onWikiLinkClick}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('overview')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('overview'));

    await waitFor(() => {
      expect(onWikiLinkClick).toHaveBeenCalledWith('overview');
    });
  });

  it('fires callback when clicking a markdown document link', async () => {
    const onWikiLinkClick = vi.fn();
    render(
      <NoteEditor
        {...baseProps}
        content={'Open [sample](./link-check.md) for the test page.'}
        onWikiLinkClick={onWikiLinkClick}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('sample')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('sample'));

    await waitFor(() => {
      expect(onWikiLinkClick).toHaveBeenCalledWith('./link-check.md');
    });
  });
});
