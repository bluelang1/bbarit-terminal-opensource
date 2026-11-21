// Settings group "Agent team" (config.json `agents.enabled`, `agents.leadPhrase`,
// src/terminal/agentTeamSwitch.ts): one switch for the app's own agent team — child agents in
// tabs, the team board and tasks, the team status view — and the phrase that starts lead mode
// (the bundled UserPromptSubmit hook reads it live). Rendered in the agent tab of SettingsPanel,
// above "Agent team board". Agents cannot read or change either through `config get|set`
// (PROTECTED_CONFIG_PATHS).

import { useEffect, useState } from 'react';
import { useConfig } from '../config/ConfigContext';
import { useTranslation } from '../i18n';
import { agentTeamEnabled, normalizeLeadPhrase, readLeadPhrase } from '../terminal/agentTeamSwitch';

export function AgentTeamSwitch() {
  const { config, updateConfig } = useConfig();
  const { t } = useTranslation();
  const on = agentTeamEnabled(config.agents);
  const saved = readLeadPhrase(config.agents);
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const check = normalizeLeadPhrase(draft);
  const save = () => {
    if (!check.ok) return;
    setDraft(check.value);
    if (check.value !== saved) updateConfig((prev) => ({ ...prev, agents: { ...prev.agents, leadPhrase: check.value } }));
  };
  return (
    <div className="settings-group">
      <h3>{t('settings.agentTeam.title')}</h3>
      <div className="setting-item toggle">
        <label htmlFor="settings-agent-team-enabled">{t('settings.agentTeam.enabled')}</label>
        <input
          id="settings-agent-team-enabled"
          type="checkbox"
          checked={on}
          onChange={(e) => {
            const enabled = e.target.checked;
            updateConfig((prev) => ({ ...prev, agents: { ...prev.agents, enabled } }));
          }}
        />
        <span className="setting-description">{t('settings.agentTeam.enabled.desc')}</span>
        <span className="setting-description">{t('settings.agentTeam.enabled.running')}</span>
      </div>
      <div className="setting-item">
        <label htmlFor="settings-agent-lead-phrase">{t('settings.agentTeam.leadPhrase')}</label>
        <input
          id="settings-agent-lead-phrase"
          type="text"
          value={draft}
          maxLength={120}
          disabled={!on}
          aria-invalid={!check.ok}
          aria-describedby="settings-agent-lead-phrase-desc"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
        />
        <span id="settings-agent-lead-phrase-desc" className="setting-description">{t('settings.agentTeam.leadPhrase.desc')}</span>
        {!check.ok && (
          <span className="setting-description" role="alert">
            {t(check.error === 'chars' ? 'settings.agentTeam.leadPhrase.badChars' : 'settings.agentTeam.leadPhrase.badLength')}
          </span>
        )}
      </div>
    </div>
  );
}
