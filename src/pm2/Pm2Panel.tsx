import React, { useState } from 'react';
import { Pm2ProcessList } from './Pm2ProcessList';
import { Pm2LogViewer } from './Pm2LogViewer';
import { ServerDashboard } from './ServerDashboard';
import { ServerAnalysisPanel } from './ServerAnalysisPanel';
import { useTranslation } from '../i18n';
import './Pm2Panel.css';

interface Props {
  workDir: string;
  isSsh: boolean;
  theme: { bg: string; text: string; border: string; accent: string };
  fontFamily: string;
  fontSize: number;
}

export const Pm2Panel: React.FC<Props> = ({ workDir, isSsh, theme, fontFamily, fontSize }) => {
  const { t } = useTranslation();
  const [selectedApp, setSelectedApp] = useState<string | null>(null);

  if (!isSsh) {
    return (
      <div className="pm2-panel" style={{ background: theme.bg, color: theme.text }}>
        <div className="pm2-no-ssh">
          <div style={{ fontSize: 40, marginBottom: 12 }}>🖥️</div>
          <h3>{t('view.pm2')}</h3>
          <p>{t('pm2.sshOnly')}</p>
          <p style={{ fontSize: 11, opacity: 0.5 }}>
            {t('pm2.sshOnlyHint')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pm2-panel" style={{ background: theme.bg, color: theme.text }}>
      <div className="pm2-three-columns" style={{ flex: 1, minHeight: 0 }}>
        {/* Left: Process List */}
        <Pm2ProcessList
          workDir={workDir}
          selectedApp={selectedApp}
          onSelectApp={setSelectedApp}
          theme={theme}
        />

        {/* Right: Log Viewer */}
        <Pm2LogViewer
          workDir={workDir}
          appName={selectedApp}
          theme={theme}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />

        {/* Right: SSH analysis tools */}
        <ServerAnalysisPanel
          workDir={workDir}
          theme={theme}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
      </div>

      {/* Server Dashboard */}
      <ServerDashboard workDir={workDir} theme={theme} />
    </div>
  );
};
