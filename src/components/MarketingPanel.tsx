import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Calendar,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  Mail,
  Pause,
  Play,
  Plus,
  Search,
  Send,
  Trash2,
  Upload,
  Users,
  Workflow,
} from 'lucide-react';
import './MarketingPanel.css';

type MarketingTheme = {
  bg: string;
  text: string;
  accent: string;
};

type SubscriberStatus = 'subscribed' | 'unsubscribed' | 'cleaned' | 'pending';

type Subscriber = {
  id: string;
  email: string;
  name: string;
  status: SubscriberStatus;
  tags: string[];
  source: string;
  joinedAt: string;
  opens: number;
  clicks: number;
};

type CampaignStatus = 'draft' | 'scheduled' | 'sent';

type Campaign = {
  id: string;
  name: string;
  subject: string;
  preview: string;
  segment: string;
  status: CampaignStatus;
  scheduledAt: string;
  sentAt?: string;
  blocks: string[];
  opens: number;
  clicks: number;
  revenue: number;
};

type Automation = {
  id: string;
  name: string;
  trigger: string;
  enabled: boolean;
  steps: string[];
  enrolled: number;
  completed: number;
};

type SignupForm = {
  headline: string;
  buttonLabel: string;
  successMessage: string;
  fields: string[];
  tags: string[];
};

type MarketingData = {
  subscribers: Subscriber[];
  campaigns: Campaign[];
  automations: Automation[];
  form: SignupForm;
};

type MarketingTab = 'dashboard' | 'audience' | 'campaigns' | 'automations' | 'forms' | 'reports';

const STORAGE_KEY = 'bbarit-marketing-suite-v1';

const todayIso = () => new Date().toISOString().slice(0, 10);

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_DATA: MarketingData = {
  subscribers: [
    {
      id: 'sub_founder',
      email: 'founder@example.com',
      name: 'Founder List',
      status: 'subscribed',
      tags: ['customer', 'launch'],
      source: 'Landing page',
      joinedAt: '2026-05-01',
      opens: 12,
      clicks: 4,
    },
    {
      id: 'sub_trial',
      email: 'trial@example.com',
      name: 'Trial User',
      status: 'subscribed',
      tags: ['trial', 'product'],
      source: 'Import',
      joinedAt: '2026-05-08',
      opens: 5,
      clicks: 1,
    },
    {
      id: 'sub_partner',
      email: 'partner@example.com',
      name: 'Partner Lead',
      status: 'pending',
      tags: ['partner'],
      source: 'Manual',
      joinedAt: '2026-05-12',
      opens: 0,
      clicks: 0,
    },
  ],
  campaigns: [
    {
      id: 'camp_launch',
      name: 'Launch digest',
      subject: 'What shipped this week',
      preview: 'A compact update for active users.',
      segment: 'launch',
      status: 'sent',
      scheduledAt: '2026-05-09',
      sentAt: '2026-05-09',
      blocks: ['Intro note', 'Three product updates', 'Primary CTA', 'Footer compliance links'],
      opens: 842,
      clicks: 143,
      revenue: 1840,
    },
    {
      id: 'camp_trial',
      name: 'Trial activation',
      subject: 'Your first workflow is ready',
      preview: 'Guide trial users to the fastest win.',
      segment: 'trial',
      status: 'scheduled',
      scheduledAt: '2026-05-18',
      blocks: ['Personalized greeting', 'Checklist', 'Demo link', 'Reply CTA'],
      opens: 0,
      clicks: 0,
      revenue: 0,
    },
  ],
  automations: [
    {
      id: 'auto_welcome',
      name: 'Welcome series',
      trigger: 'New subscriber',
      enabled: true,
      steps: ['Send welcome email immediately', 'Wait 2 days', 'Send product tour', 'Tag engaged leads'],
      enrolled: 318,
      completed: 241,
    },
    {
      id: 'auto_reengage',
      name: 'Re-engagement',
      trigger: 'No opens for 30 days',
      enabled: false,
      steps: ['Send check-in', 'Wait 5 days', 'Offer preference center', 'Suppress inactive contacts'],
      enrolled: 82,
      completed: 47,
    },
  ],
  form: {
    headline: 'Get product updates',
    buttonLabel: 'Subscribe',
    successMessage: 'Thanks. Check your inbox to confirm.',
    fields: ['email', 'first_name', 'company'],
    tags: ['newsletter', 'website'],
  },
};

function loadMarketingData(): MarketingData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DATA;
    const parsed = JSON.parse(raw) as Partial<MarketingData>;
    return {
      subscribers: Array.isArray(parsed.subscribers) ? parsed.subscribers : DEFAULT_DATA.subscribers,
      campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns : DEFAULT_DATA.campaigns,
      automations: Array.isArray(parsed.automations) ? parsed.automations : DEFAULT_DATA.automations,
      form: parsed.form && typeof parsed.form === 'object' ? { ...DEFAULT_DATA.form, ...parsed.form } : DEFAULT_DATA.form,
    };
  } catch {
    return DEFAULT_DATA;
  }
}

const splitCsv = (value: string) =>
  value.split(',').map((item) => item.trim()).filter(Boolean);

const pct = (part: number, total: number) => {
  if (!total) return '0%';
  return `${Math.round((part / total) * 100)}%`;
};

const money = (value: number) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

export function MarketingPanel({ theme }: { theme: MarketingTheme }) {
  const [data, setData] = useState<MarketingData>(() => loadMarketingData());
  const [activeTab, setActiveTab] = useState<MarketingTab>('dashboard');
  const [audienceQuery, setAudienceQuery] = useState('');
  const [campaignId, setCampaignId] = useState(data.campaigns[0]?.id || '');
  const [newSubscriber, setNewSubscriber] = useState({ email: '', name: '', tags: '', source: 'Manual' });
  const [importText, setImportText] = useState('');
  const [draft, setDraft] = useState<Campaign>(() => ({
    id: newId('camp'),
    name: 'New campaign',
    subject: 'A useful update for you',
    preview: 'Short preview text that explains why this email matters.',
    segment: 'newsletter',
    status: 'draft',
    scheduledAt: todayIso(),
    blocks: ['Opening hook', 'Main story', 'Product CTA', 'Preference footer'],
    opens: 0,
    clicks: 0,
    revenue: 0,
  }));
  const [copyState, setCopyState] = useState('');

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  useEffect(() => {
    if (copyState) {
      const timer = window.setTimeout(() => setCopyState(''), 1800);
      return () => window.clearTimeout(timer);
    }
  }, [copyState]);

  const selectedCampaign = useMemo(
    () => data.campaigns.find((campaign) => campaign.id === campaignId) || data.campaigns[0] || null,
    [campaignId, data.campaigns],
  );

  const segments = useMemo(() => {
    const tagCounts = new Map<string, number>();
    for (const subscriber of data.subscribers) {
      for (const tag of subscriber.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    return Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [data.subscribers]);

  const audienceStats = useMemo(() => {
    const subscribed = data.subscribers.filter((subscriber) => subscriber.status === 'subscribed').length;
    const pending = data.subscribers.filter((subscriber) => subscriber.status === 'pending').length;
    const cleaned = data.subscribers.filter((subscriber) => subscriber.status === 'cleaned').length;
    const opens = data.subscribers.reduce((sum, subscriber) => sum + subscriber.opens, 0);
    const clicks = data.subscribers.reduce((sum, subscriber) => sum + subscriber.clicks, 0);
    return { subscribed, pending, cleaned, opens, clicks };
  }, [data.subscribers]);

  const campaignStats = useMemo(() => {
    const sent = data.campaigns.filter((campaign) => campaign.status === 'sent');
    const opens = sent.reduce((sum, campaign) => sum + campaign.opens, 0);
    const clicks = sent.reduce((sum, campaign) => sum + campaign.clicks, 0);
    const revenue = sent.reduce((sum, campaign) => sum + campaign.revenue, 0);
    return { sent: sent.length, opens, clicks, revenue };
  }, [data.campaigns]);

  const filteredSubscribers = useMemo(() => {
    const q = audienceQuery.trim().toLowerCase();
    if (!q) return data.subscribers;
    return data.subscribers.filter((subscriber) =>
      subscriber.email.toLowerCase().includes(q)
      || subscriber.name.toLowerCase().includes(q)
      || subscriber.status.includes(q)
      || subscriber.source.toLowerCase().includes(q)
      || subscriber.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [audienceQuery, data.subscribers]);

  const addSubscriber = () => {
    const email = newSubscriber.email.trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    setData((current) => ({
      ...current,
      subscribers: [
        {
          id: newId('sub'),
          email,
          name: newSubscriber.name.trim() || email.split('@')[0],
          status: 'subscribed',
          tags: splitCsv(newSubscriber.tags),
          source: newSubscriber.source.trim() || 'Manual',
          joinedAt: todayIso(),
          opens: 0,
          clicks: 0,
        },
        ...current.subscribers.filter((subscriber) => subscriber.email.toLowerCase() !== email),
      ],
    }));
    setNewSubscriber({ email: '', name: '', tags: '', source: 'Manual' });
  };

  const importSubscribers = () => {
    const rows = importText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!rows.length) return;
    const imported: Subscriber[] = rows.map((line) => {
      const [emailRaw, nameRaw, tagsRaw = '', sourceRaw = 'CSV'] = line.split(',').map((part) => part.trim());
      const email = emailRaw.toLowerCase();
      const status: SubscriberStatus = email.includes('@') ? 'subscribed' : 'cleaned';
      return {
        id: newId('sub'),
        email,
        name: nameRaw || email.split('@')[0] || 'Subscriber',
        status,
        tags: splitCsv(tagsRaw),
        source: sourceRaw || 'CSV',
        joinedAt: todayIso(),
        opens: 0,
        clicks: 0,
      };
    }).filter((subscriber) => subscriber.email);
    setData((current) => {
      const existing = new Map(current.subscribers.map((subscriber) => [subscriber.email.toLowerCase(), subscriber]));
      for (const subscriber of imported) existing.set(subscriber.email.toLowerCase(), subscriber);
      return { ...current, subscribers: Array.from(existing.values()) };
    });
    setImportText('');
  };

  const deleteSubscriber = (id: string) => {
    setData((current) => ({ ...current, subscribers: current.subscribers.filter((subscriber) => subscriber.id !== id) }));
  };

  const saveCampaign = () => {
    setData((current) => {
      const exists = current.campaigns.some((campaign) => campaign.id === draft.id);
      const nextCampaign = { ...draft, blocks: draft.blocks.map((block) => block.trim()).filter(Boolean) };
      return {
        ...current,
        campaigns: exists
          ? current.campaigns.map((campaign) => campaign.id === draft.id ? nextCampaign : campaign)
          : [nextCampaign, ...current.campaigns],
      };
    });
    setCampaignId(draft.id);
  };

  const simulateSend = (id: string) => {
    setData((current) => ({
      ...current,
      campaigns: current.campaigns.map((campaign) => {
        if (campaign.id !== id) return campaign;
        const audience = Math.max(1, data.subscribers.filter((subscriber) =>
          campaign.segment === 'all' || subscriber.tags.includes(campaign.segment)
        ).length || data.subscribers.length);
        const opens = Math.round(audience * 0.46);
        const clicks = Math.round(opens * 0.18);
        return {
          ...campaign,
          status: 'sent',
          sentAt: todayIso(),
          opens,
          clicks,
          revenue: campaign.revenue || clicks * 18,
        };
      }),
    }));
  };

  const setCampaignStatus = (id: string, status: CampaignStatus) => {
    setData((current) => ({
      ...current,
      campaigns: current.campaigns.map((campaign) => campaign.id === id ? { ...campaign, status } : campaign),
    }));
  };

  const deleteCampaign = (id: string) => {
    setData((current) => ({ ...current, campaigns: current.campaigns.filter((campaign) => campaign.id !== id) }));
    if (campaignId === id) setCampaignId('');
  };

  const toggleAutomation = (id: string) => {
    setData((current) => ({
      ...current,
      automations: current.automations.map((automation) =>
        automation.id === id ? { ...automation, enabled: !automation.enabled } : automation
      ),
    }));
  };

  const addAutomation = () => {
    setData((current) => ({
      ...current,
      automations: [
        {
          id: newId('auto'),
          name: 'New customer journey',
          trigger: 'Tag added',
          enabled: false,
          steps: ['Check segment', 'Send email', 'Wait 3 days', 'Branch by engagement'],
          enrolled: 0,
          completed: 0,
        },
        ...current.automations,
      ],
    }));
  };

  const updateForm = (patch: Partial<SignupForm>) => {
    setData((current) => ({ ...current, form: { ...current.form, ...patch } }));
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState(`${label} copied`);
    } catch {
      setCopyState('Copy failed');
    }
  };

  const exportJson = () => {
    const payload = JSON.stringify(data, null, 2);
    void copyText(payload, 'JSON export');
  };

  const embedSnippet = [
    '<form data-bbarit-marketing-form>',
    `  <h2>${data.form.headline}</h2>`,
    ...data.form.fields.map((field) => `  <input name="${field}" placeholder="${field.replace(/_/g, ' ')}" />`),
    `  <button>${data.form.buttonLabel}</button>`,
    '</form>',
  ].join('\n');

  const audiencePrompt = [
    'Build an email marketing plan using this audience snapshot:',
    `- Subscribers: ${data.subscribers.length}`,
    `- Active: ${audienceStats.subscribed}`,
    `- Segments: ${segments.map((segment) => `${segment.name} (${segment.count})`).join(', ') || 'none'}`,
    `- Recent campaign open rate: ${pct(campaignStats.opens, Math.max(campaignStats.sent * 1000, 1))}`,
    'Include: segmentation, campaign calendar, automation journeys, compliance checklist, and analytics plan.',
  ].join('\n');

  return (
    <div
      className="marketing-panel"
      style={{
        '--marketing-bg': theme.bg,
        '--marketing-text': theme.text,
        '--marketing-accent': theme.accent,
      } as React.CSSProperties}
    >
      <div className="marketing-panel-head">
        <div>
          <div className="marketing-panel-title">
            <Mail size={14} />
            <span>Marketing</span>
          </div>
          <div className="marketing-panel-subtitle">Audience, campaigns, automations, forms, and reports</div>
        </div>
        <button className="marketing-icon-button" type="button" onClick={exportJson} title="Copy JSON export">
          <Download size={13} />
        </button>
      </div>

      <div className="marketing-tabs" role="tablist" aria-label="Marketing tools">
        {[
          ['dashboard', BarChart3],
          ['audience', Users],
          ['campaigns', Mail],
          ['automations', Workflow],
          ['forms', Upload],
          ['reports', BarChart3],
        ].map(([tab, Icon]) => (
          <button
            key={tab as string}
            className={`marketing-tab ${activeTab === tab ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTab(tab as MarketingTab)}
            title={String(tab)}
          >
            <Icon size={13} />
          </button>
        ))}
      </div>

      {copyState && <div className="marketing-toast">{copyState}</div>}

      <div className="marketing-scroll">
        {activeTab === 'dashboard' && (
          <>
            <div className="marketing-metrics">
              <Metric label="Subscribers" value={data.subscribers.length} detail={`${audienceStats.subscribed} active`} />
              <Metric label="Segments" value={segments.length} detail="tag based" />
              <Metric label="Sent" value={campaignStats.sent} detail={`${campaignStats.clicks} clicks`} />
              <Metric label="Revenue" value={money(campaignStats.revenue)} detail="attributed" />
            </div>
            <section className="marketing-section">
              <div className="marketing-section-title">Growth snapshot</div>
              <div className="marketing-bars">
                <Bar label="Open activity" value={audienceStats.opens} max={Math.max(1, audienceStats.opens + audienceStats.clicks)} />
                <Bar label="Click activity" value={audienceStats.clicks} max={Math.max(1, audienceStats.opens + audienceStats.clicks)} />
                <Bar label="Pending contacts" value={audienceStats.pending} max={Math.max(1, data.subscribers.length)} />
                <Bar label="Cleaned contacts" value={audienceStats.cleaned} max={Math.max(1, data.subscribers.length)} />
              </div>
            </section>
            <section className="marketing-section">
              <div className="marketing-section-title">Next best actions</div>
              <div className="marketing-action-list">
                <button type="button" onClick={() => setActiveTab('campaigns')}><Send size={13} /> Create a campaign</button>
                <button type="button" onClick={() => setActiveTab('automations')}><Workflow size={13} /> Tune a journey</button>
                <button type="button" onClick={() => void copyText(audiencePrompt, 'Planning prompt')}><Copy size={13} /> Copy planning prompt</button>
              </div>
            </section>
          </>
        )}

        {activeTab === 'audience' && (
          <>
            <section className="marketing-section">
              <div className="marketing-section-title">Add subscriber</div>
              <div className="marketing-grid-form">
                <input value={newSubscriber.email} onChange={(event) => setNewSubscriber((value) => ({ ...value, email: event.target.value }))} placeholder="email@example.com" />
                <input value={newSubscriber.name} onChange={(event) => setNewSubscriber((value) => ({ ...value, name: event.target.value }))} placeholder="Name" />
                <input value={newSubscriber.tags} onChange={(event) => setNewSubscriber((value) => ({ ...value, tags: event.target.value }))} placeholder="tags, comma separated" />
                <input value={newSubscriber.source} onChange={(event) => setNewSubscriber((value) => ({ ...value, source: event.target.value }))} placeholder="Source" />
                <button type="button" onClick={addSubscriber}><Plus size={13} /> Add</button>
              </div>
            </section>
            <section className="marketing-section">
              <div className="marketing-section-title">Bulk import</div>
              <textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder="email,name,tags,source"
                rows={4}
              />
              <button type="button" className="marketing-wide-button" onClick={importSubscribers}><Upload size={13} /> Import CSV lines</button>
            </section>
            <section className="marketing-section">
              <div className="marketing-search">
                <Search size={13} />
                <input value={audienceQuery} onChange={(event) => setAudienceQuery(event.target.value)} placeholder="Search contacts, tags, status..." />
              </div>
              <div className="marketing-list">
                {filteredSubscribers.map((subscriber) => (
                  <div className="marketing-row" key={subscriber.id}>
                    <div className="marketing-row-main">
                      <strong>{subscriber.name}</strong>
                      <span>{subscriber.email}</span>
                      <em>{subscriber.tags.join(', ') || 'untagged'} · {subscriber.status}</em>
                    </div>
                    <button type="button" onClick={() => deleteSubscriber(subscriber.id)} title="Delete subscriber"><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}

        {activeTab === 'campaigns' && (
          <>
            <section className="marketing-section">
              <div className="marketing-section-title">Campaign builder</div>
              <div className="marketing-grid-form">
                <input value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} placeholder="Campaign name" />
                <input value={draft.subject} onChange={(event) => setDraft((value) => ({ ...value, subject: event.target.value }))} placeholder="Subject" />
                <input value={draft.preview} onChange={(event) => setDraft((value) => ({ ...value, preview: event.target.value }))} placeholder="Preview text" />
                <select value={draft.segment} onChange={(event) => setDraft((value) => ({ ...value, segment: event.target.value }))}>
                  <option value="all">All contacts</option>
                  {segments.map((segment) => <option key={segment.name} value={segment.name}>{segment.name} ({segment.count})</option>)}
                </select>
                <input type="date" value={draft.scheduledAt} onChange={(event) => setDraft((value) => ({ ...value, scheduledAt: event.target.value }))} />
              </div>
              <textarea
                value={draft.blocks.join('\n')}
                onChange={(event) => setDraft((value) => ({ ...value, blocks: event.target.value.split(/\r?\n/) }))}
                rows={5}
                placeholder="One email content block per line"
              />
              <div className="marketing-button-row">
                <button type="button" onClick={saveCampaign}><CheckCircle2 size={13} /> Save draft</button>
                <button type="button" onClick={() => setDraft({ ...draft, id: newId('camp'), name: 'New campaign' })}><Plus size={13} /> New</button>
              </div>
            </section>

            <section className="marketing-section">
              <div className="marketing-section-title">Campaigns</div>
              <div className="marketing-list">
                {data.campaigns.map((campaign) => (
                  <div className={`marketing-row ${selectedCampaign?.id === campaign.id ? 'selected' : ''}`} key={campaign.id}>
                    <button type="button" className="marketing-row-main marketing-row-button" onClick={() => { setCampaignId(campaign.id); setDraft(campaign); }}>
                      <strong>{campaign.name}</strong>
                      <span>{campaign.subject}</span>
                      <em>{campaign.status} · {campaign.segment} · {campaign.scheduledAt}</em>
                    </button>
                    <button type="button" onClick={() => campaign.status === 'scheduled' ? setCampaignStatus(campaign.id, 'draft') : setCampaignStatus(campaign.id, 'scheduled')} title="Toggle schedule">
                      <Calendar size={13} />
                    </button>
                    <button type="button" onClick={() => simulateSend(campaign.id)} title="Simulate send">
                      <Send size={13} />
                    </button>
                    <button type="button" onClick={() => deleteCampaign(campaign.id)} title="Delete campaign">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </section>

            {selectedCampaign && (
              <section className="marketing-section">
                <div className="marketing-section-title"><Eye size={13} /> Preview</div>
                <div className="marketing-email-preview">
                  <div className="marketing-email-subject">{selectedCampaign.subject}</div>
                  <div className="marketing-email-preheader">{selectedCampaign.preview}</div>
                  {selectedCampaign.blocks.map((block, index) => <p key={`${selectedCampaign.id}-${index}`}>{block}</p>)}
                  <button type="button">Primary call to action</button>
                </div>
              </section>
            )}
          </>
        )}

        {activeTab === 'automations' && (
          <>
            <div className="marketing-button-row">
              <button type="button" onClick={addAutomation}><Plus size={13} /> Add journey</button>
            </div>
            <div className="marketing-list">
              {data.automations.map((automation) => (
                <section className="marketing-section" key={automation.id}>
                  <div className="marketing-automation-head">
                    <div>
                      <div className="marketing-section-title">{automation.name}</div>
                      <span>{automation.trigger}</span>
                    </div>
                    <button type="button" onClick={() => toggleAutomation(automation.id)} title={automation.enabled ? 'Pause' : 'Start'}>
                      {automation.enabled ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                  </div>
                  <div className="marketing-journey">
                    {automation.steps.map((step, index) => (
                      <div className="marketing-step" key={`${automation.id}-${index}`}>
                        <span>{index + 1}</span>
                        <strong>{step}</strong>
                      </div>
                    ))}
                  </div>
                  <div className="marketing-inline-stats">
                    <span>{automation.enabled ? 'Running' : 'Paused'}</span>
                    <span>{automation.enrolled} enrolled</span>
                    <span>{pct(automation.completed, Math.max(1, automation.enrolled))} completed</span>
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        {activeTab === 'forms' && (
          <>
            <section className="marketing-section">
              <div className="marketing-section-title">Signup form</div>
              <div className="marketing-grid-form">
                <input value={data.form.headline} onChange={(event) => updateForm({ headline: event.target.value })} placeholder="Headline" />
                <input value={data.form.buttonLabel} onChange={(event) => updateForm({ buttonLabel: event.target.value })} placeholder="Button label" />
                <input value={data.form.successMessage} onChange={(event) => updateForm({ successMessage: event.target.value })} placeholder="Success message" />
                <input value={data.form.fields.join(', ')} onChange={(event) => updateForm({ fields: splitCsv(event.target.value) })} placeholder="fields" />
                <input value={data.form.tags.join(', ')} onChange={(event) => updateForm({ tags: splitCsv(event.target.value) })} placeholder="tags" />
              </div>
            </section>
            <section className="marketing-section">
              <div className="marketing-form-preview">
                <h3>{data.form.headline}</h3>
                {data.form.fields.map((field) => <input key={field} readOnly placeholder={field.replace(/_/g, ' ')} />)}
                <button type="button">{data.form.buttonLabel}</button>
                <span>{data.form.successMessage}</span>
              </div>
              <button type="button" className="marketing-wide-button" onClick={() => void copyText(embedSnippet, 'Embed snippet')}>
                <Copy size={13} /> Copy embed snippet
              </button>
            </section>
          </>
        )}

        {activeTab === 'reports' && (
          <>
            <section className="marketing-section">
              <div className="marketing-section-title">Campaign performance</div>
              <div className="marketing-list">
                {data.campaigns.map((campaign) => (
                  <div className="marketing-report" key={campaign.id}>
                    <div>
                      <strong>{campaign.name}</strong>
                      <span>{campaign.subject}</span>
                    </div>
                    <div className="marketing-report-grid">
                      <Metric label="Opens" value={campaign.opens} detail={campaign.status} compact />
                      <Metric label="Clicks" value={campaign.clicks} detail={pct(campaign.clicks, Math.max(1, campaign.opens))} compact />
                      <Metric label="Revenue" value={money(campaign.revenue)} detail={campaign.segment} compact />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, detail, compact = false }: { label: string; value: React.ReactNode; detail: string; compact?: boolean }) {
  return (
    <div className={`marketing-metric ${compact ? 'compact' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </div>
  );
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.max(4, Math.min(100, Math.round((value / max) * 100)))}%`;
  return (
    <div className="marketing-bar">
      <div className="marketing-bar-label"><span>{label}</span><strong>{value}</strong></div>
      <div className="marketing-bar-track"><span style={{ width }} /></div>
    </div>
  );
}

export default MarketingPanel;
