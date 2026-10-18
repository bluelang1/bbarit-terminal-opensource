/**
 * SidebarTabs.tsx
 *
 * Tab switcher for the sidebar: Project / Notes.
 * Shows a tab bar at the top with accent-colored underline for the active tab.
 * Renders children content below based on activeTab.
 */

import type { ReactNode, ComponentType } from 'react';
import { FileCode2, Folder } from 'lucide-react';
import { OctoSkill } from '../octoIcons';
import { useTranslation, type TranslationKey } from '../i18n';
import './SidebarTabs.css';

export type SidebarTab = 'files' | 'notes' | 'wiki' | 'skills' | 'codeSearch';

export interface SidebarTabsProps {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  children: ReactNode;
  style: { bg: string; text: string; accent: string };
}

const SkillIcon: ComponentType<{ size?: number }> = ({ size }) => <OctoSkill size={size || 13} />;

const TAB_CONFIG: { id: SidebarTab; labelKey?: TranslationKey; label?: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: 'files', labelKey: 'sidebar.files', Icon: Folder },
  { id: 'codeSearch', labelKey: 'sidebar.codeSearch', Icon: FileCode2 },
  { id: 'skills', labelKey: 'sidebar.skills', Icon: SkillIcon },
];

export function SidebarTabs({ activeTab, onTabChange, children, style }: SidebarTabsProps) {
  const { t } = useTranslation();
  return (
    <div
      className="sidebar-tabs"
      style={{
        '--st-bg': style.bg,
        '--st-text': style.text,
        '--st-accent': style.accent,
      } as React.CSSProperties}
    >
      <div className="sidebar-tabs-bar" role="tablist" aria-label={t('sidebar.tabsAria')}>
        {TAB_CONFIG.map(({ id, labelKey, label, Icon }) => {
          const buttonLabel = label || (labelKey ? t(labelKey) : id);
          return (
          <button
            key={id}
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`sidebar-tabpanel-${id}`}
            id={`sidebar-tab-${id}`}
            className={`sidebar-tabs-button ${activeTab === id ? 'active' : ''}`}
            onClick={() => onTabChange(id)}
            title={buttonLabel}
          >
            <Icon size={13} aria-hidden="true" />
          </button>
        )})}
      </div>
      <div
        className="sidebar-tabs-content"
        role="tabpanel"
        id={`sidebar-tabpanel-${activeTab}`}
        aria-labelledby={`sidebar-tab-${activeTab}`}
      >
        {children}
      </div>
    </div>
  );
}
