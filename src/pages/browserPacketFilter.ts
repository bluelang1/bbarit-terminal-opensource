export type PacketStatusFilter = 'all' | 'success' | 'redirect' | 'client-error' | 'server-error' | 'failed' | 'unknown';
export type PacketCacheFilter = 'all' | 'cached' | 'network';
export type PacketSort = 'newest' | 'oldest' | 'slowest' | 'largest' | 'status';

export interface FilterablePacket {
  id: string;
  url: string;
  method?: string;
  status?: number | null;
  statusText?: string;
  resourceType?: string;
  mimeType?: string;
  failed?: boolean;
  errorText?: string;
  fromDiskCache?: boolean;
  startedAt?: string;
  durationMs?: number | null;
  encodedDataLength?: number | null;
}

export interface PacketFilterOptions {
  query: string;
  method: string;
  domain: string;
  status: PacketStatusFilter;
  resourceTypes: string[];
  cache: PacketCacheFilter;
  minDurationMs: number;
  minSizeBytes: number;
  sort: PacketSort;
}

export function packetDomain(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query.trim()))) tokens.push(String(match[1] || match[2] || '').toLowerCase());
  return tokens.filter(Boolean);
}

function matchesStatus(packet: FilterablePacket, filter: PacketStatusFilter): boolean {
  const status = Number(packet.status || 0);
  if (filter === 'all') return true;
  if (filter === 'failed') return !!packet.failed || status >= 400;
  if (filter === 'unknown') return !packet.failed && status === 0;
  if (filter === 'success') return status >= 200 && status < 300;
  if (filter === 'redirect') return status >= 300 && status < 400;
  if (filter === 'client-error') return status >= 400 && status < 500;
  return status >= 500;
}

function statusTokenMatches(packet: FilterablePacket, value: string): boolean {
  const status = Number(packet.status || 0);
  if (value === 'error' || value === 'failed') return !!packet.failed || status >= 400;
  if (value === 'unknown' || value === 'pending') return !packet.failed && status === 0;
  if (/^[1-5]xx$/.test(value)) return Math.floor(status / 100) === Number(value[0]);
  return String(packet.status ?? '').includes(value);
}

function queryTokenMatches(packet: FilterablePacket, rawToken: string): boolean {
  const token = rawToken.startsWith('-') ? rawToken.slice(1) : rawToken;
  const separator = token.indexOf(':');
  const field = separator > 0 ? token.slice(0, separator) : '';
  const value = separator > 0 ? token.slice(separator + 1) : token;
  const domain = packetDomain(packet.url);
  if (!value) return true;
  if (field === 'method') return String(packet.method || '').toLowerCase() === value;
  if (field === 'type') return String(packet.resourceType || '').toLowerCase().includes(value);
  if (field === 'domain' || field === 'host') return domain.includes(value);
  if (field === 'status') return statusTokenMatches(packet, value);
  if (field === 'mime') return String(packet.mimeType || '').toLowerCase().includes(value);
  if (field === 'is') {
    if (value === 'cached' || value === 'cache') return !!packet.fromDiskCache;
    if (value === 'failed' || value === 'error') return !!packet.failed || Number(packet.status || 0) >= 400;
    if (value === 'unknown' || value === 'pending') return !packet.failed && !packet.status;
  }
  const haystack = [
    packet.url, domain, packet.method, packet.status, packet.statusText,
    packet.resourceType, packet.mimeType, packet.errorText,
  ].map((part) => String(part ?? '').toLowerCase()).join(' ');
  return haystack.includes(value);
}

export function filterAndSortPackets<T extends FilterablePacket>(packets: T[], options: PacketFilterOptions): T[] {
  const tokens = tokenizeQuery(options.query);
  const selectedTypes = new Set(options.resourceTypes.map((type) => type.toLowerCase()));
  const filtered = packets.filter((packet) => {
    if (options.method !== 'all' && String(packet.method || '').toLowerCase() !== options.method.toLowerCase()) return false;
    if (options.domain !== 'all' && packetDomain(packet.url) !== options.domain.toLowerCase()) return false;
    if (!matchesStatus(packet, options.status)) return false;
    if (selectedTypes.size && !selectedTypes.has(String(packet.resourceType || 'Other').toLowerCase())) return false;
    if (options.cache === 'cached' && !packet.fromDiskCache) return false;
    if (options.cache === 'network' && packet.fromDiskCache) return false;
    if ((Number(packet.durationMs) || 0) < Math.max(0, options.minDurationMs)) return false;
    if ((Number(packet.encodedDataLength) || 0) < Math.max(0, options.minSizeBytes)) return false;
    return tokens.every((rawToken) => {
      const matched = queryTokenMatches(packet, rawToken);
      return rawToken.startsWith('-') ? !matched : matched;
    });
  });

  return filtered.slice().sort((a, b) => {
    if (options.sort === 'oldest') return String(a.startedAt || '').localeCompare(String(b.startedAt || ''));
    if (options.sort === 'slowest') return (Number(b.durationMs) || 0) - (Number(a.durationMs) || 0);
    if (options.sort === 'largest') return (Number(b.encodedDataLength) || 0) - (Number(a.encodedDataLength) || 0);
    if (options.sort === 'status') return (Number(b.status) || 0) - (Number(a.status) || 0);
    return String(b.startedAt || '').localeCompare(String(a.startedAt || ''));
  });
}

export function packetFacetValues(packets: FilterablePacket[]) {
  const methods = Array.from(new Set(packets.map((packet) => String(packet.method || 'GET').toUpperCase()))).sort();
  const domains = Array.from(new Set(packets.map((packet) => packetDomain(packet.url)).filter(Boolean))).sort();
  const preferredTypes = ['Document', 'XHR', 'Fetch', 'Script', 'Stylesheet', 'Image', 'Font', 'Media', 'Other'];
  const foundTypes = new Set(packets.map((packet) => String(packet.resourceType || 'Other')));
  const resourceTypes = [
    ...preferredTypes.filter((type) => foundTypes.has(type)),
    ...Array.from(foundTypes).filter((type) => !preferredTypes.includes(type)).sort(),
  ];
  return { methods, domains, resourceTypes };
}
