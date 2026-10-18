import { describe, expect, it } from 'vitest';
import { filterAndSortPackets, packetFacetValues, type FilterablePacket, type PacketFilterOptions } from './browserPacketFilter';

const packets: FilterablePacket[] = [
  { id: '1', url: 'https://www.naver.com/', method: 'GET', status: 200, resourceType: 'Document', durationMs: 80, encodedDataLength: 5000, startedAt: '2026-01-01T00:00:01Z' },
  { id: '2', url: 'https://api.naver.com/users', method: 'POST', status: 500, resourceType: 'XHR', durationMs: 450, encodedDataLength: 12000, startedAt: '2026-01-01T00:00:03Z' },
  { id: '3', url: 'https://ssl.pstatic.net/banner.webp', method: 'GET', status: null, resourceType: 'Image', durationMs: 20, encodedDataLength: 24000, fromDiskCache: true, startedAt: '2026-01-01T00:00:02Z' },
];

const defaults: PacketFilterOptions = { query: '', method: 'all', domain: 'all', status: 'all', resourceTypes: [], cache: 'all', minDurationMs: 0, minSizeBytes: 0, sort: 'newest' };

describe('browser packet filters', () => {
  it('combines domain, method, status, type, timing, and size filters', () => {
    expect(filterAndSortPackets(packets, { ...defaults, domain: 'api.naver.com', method: 'POST', status: 'server-error', resourceTypes: ['XHR'], minDurationMs: 400, minSizeBytes: 10000 }).map((p) => p.id)).toEqual(['2']);
  });

  it('supports field queries, quoted terms, and exclusions', () => {
    expect(filterAndSortPackets(packets, { ...defaults, query: 'domain:naver.com status:5xx' }).map((p) => p.id)).toEqual(['2']);
    expect(filterAndSortPackets(packets, { ...defaults, query: 'GET -pstatic' }).map((p) => p.id)).toEqual(['1']);
    expect(filterAndSortPackets(packets, { ...defaults, query: 'is:cached' }).map((p) => p.id)).toEqual(['3']);
  });

  it('sorts by duration/size and builds stable facets', () => {
    expect(filterAndSortPackets(packets, { ...defaults, sort: 'slowest' }).map((p) => p.id)).toEqual(['2', '1', '3']);
    expect(filterAndSortPackets(packets, { ...defaults, sort: 'largest' }).map((p) => p.id)).toEqual(['3', '2', '1']);
    expect(packetFacetValues(packets)).toEqual({ methods: ['GET', 'POST'], domains: ['api.naver.com', 'ssl.pstatic.net', 'www.naver.com'], resourceTypes: ['Document', 'XHR', 'Image'] });
  });
});
