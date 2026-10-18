/**
 * MCP Server Presets — 300+ 원클릭 추가 프리셋
 * 카테고리별로 정리. awesome-mcp-servers, smithery.ai, 공식 레지스트리 참고.
 */

export interface McpPreset {
  label: string;
  name: string;
  command: string;
  args: string;
  env?: string;
  category: McpPresetCategory;
  description: string;
}

export type McpPresetCategory =
  | 'official'     // 공식 레퍼런스 서버
  | 'filesystem'   // 파일 시스템
  | 'git'          // Git / 버전 관리
  | 'database'     // 데이터베이스
  | 'cloud'        // 클라우드 / 인프라
  | 'ai'           // AI / LLM
  | 'communication'// Slack, Discord, Email
  | 'search'       // 검색 엔진
  | 'monitoring'   // 모니터링 / 로깅
  | 'security'     // 보안
  | 'productivity' // 생산성 도구
  | 'data'         // 데이터 처리
  | 'web'          // 웹 / 브라우저
  | 'devtools'     // 개발 도구
  | 'testing'      // 테스트
  | 'docs'         // 문서
  | 'media'        // 미디어
  | 'devops'       // DevOps / CI/CD
  | 'api'          // API 연동
  | 'analytics'    // 분석
  | 'finance'      // 금융/핀테크
  | 'social'       // 소셜미디어
  | 'automation'   // 자동화/RPA
  | 'design'       // 디자인/UI
  | 'blockchain'   // 블록체인/Web3
  | 'cms'          // CMS/콘텐츠
  | 'education'    // 교육/학습
  | 'maps'         // 지도/위치
  | 'other';       // 기타

export const MCP_PRESET_CATEGORIES: { key: McpPresetCategory; label: string; emoji: string }[] = [
  { key: 'official', label: 'Official', emoji: '⭐' },
  { key: 'filesystem', label: 'Files', emoji: '📁' },
  { key: 'git', label: 'Git', emoji: '🔀' },
  { key: 'database', label: 'DB', emoji: '🗄️' },
  { key: 'cloud', label: 'Cloud', emoji: '☁️' },
  { key: 'ai', label: 'AI', emoji: '🤖' },
  { key: 'communication', label: 'Communication', emoji: '💬' },
  { key: 'search', label: 'Search', emoji: '🔍' },
  { key: 'web', label: 'Web', emoji: '🌐' },
  { key: 'devtools', label: 'Dev Tools', emoji: '🛠️' },
  { key: 'devops', label: 'DevOps', emoji: '🚀' },
  { key: 'testing', label: 'Testing', emoji: '🧪' },
  { key: 'monitoring', label: 'Monitoring', emoji: '📈' },
  { key: 'security', label: 'Security', emoji: '🔒' },
  { key: 'productivity', label: 'Productivity', emoji: '📋' },
  { key: 'data', label: 'Data', emoji: '📊' },
  { key: 'docs', label: 'Docs', emoji: '📖' },
  { key: 'media', label: 'Media', emoji: '🎨' },
  { key: 'api', label: 'API', emoji: '🔌' },
  { key: 'analytics', label: 'Analytics', emoji: '📉' },
  { key: 'finance', label: 'Finance', emoji: '💰' },
  { key: 'social', label: 'Social', emoji: '👥' },
  { key: 'automation', label: 'Automation', emoji: '⚙️' },
  { key: 'design', label: 'Design', emoji: '🖌️' },
  { key: 'blockchain', label: 'Blockchain', emoji: '⛓️' },
  { key: 'cms', label: 'CMS', emoji: '📝' },
  { key: 'education', label: 'Education', emoji: '🎓' },
  { key: 'maps', label: 'Maps', emoji: '🗺️' },
  { key: 'other', label: 'Other', emoji: '📦' },
];

export const MCP_PRESETS: McpPreset[] = [
  // ═══════════════════════════════════════════
  // ── 공식 레퍼런스 (Official) ──
  // ═══════════════════════════════════════════
  { label: 'Filesystem', name: 'filesystem', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem /tmp', category: 'official', description: 'Read/write/search files' },
  { label: 'Git', name: 'git', command: 'npx', args: '-y @modelcontextprotocol/server-git', category: 'official', description: 'Read/search Git repositories' },
  { label: 'Memory', name: 'memory', command: 'npx', args: '-y @modelcontextprotocol/server-memory', category: 'official', description: 'Knowledge-graph-based persistent memory' },
  { label: 'Fetch', name: 'fetch', command: 'npx', args: '-y @modelcontextprotocol/server-fetch', category: 'official', description: 'Fetch web pages' },
  { label: 'Time', name: 'time', command: 'npx', args: '-y @modelcontextprotocol/server-time', category: 'official', description: 'Time/timezone conversion' },
  { label: 'Sequential Thinking', name: 'sequentialthinking', command: 'npx', args: '-y @modelcontextprotocol/server-sequentialthinking', category: 'official', description: 'Step-by-step chain of thought' },
  { label: 'Everything', name: 'everything', command: 'npx', args: '-y @modelcontextprotocol/server-everything', category: 'official', description: 'Test/reference server' },

  // ═══════════════════════════════════════════
  // ── Git / 버전 관리 ──
  // ═══════════════════════════════════════════
  { label: 'GitHub', name: 'github', command: 'npx', args: '-y @modelcontextprotocol/server-github', env: 'GITHUB_PERSONAL_ACCESS_TOKEN=', category: 'git', description: 'GitHub API (PRs, issues, code)' },
  { label: 'GitLab', name: 'gitlab', command: 'npx', args: '-y @modelcontextprotocol/server-gitlab', env: 'GITLAB_PERSONAL_ACCESS_TOKEN=\nGITLAB_API_URL=https://gitlab.com/api/v4', category: 'git', description: 'GitLab project management' },
  { label: 'Git MCP (mseep)', name: 'git-mseep', command: 'npx', args: '-y @mseep/git-mcp-server', category: 'git', description: 'Git repository analysis/search' },
  { label: 'Bitbucket', name: 'bitbucket', command: 'npx', args: '-y @anthropics/mcp-server-bitbucket', env: 'BITBUCKET_USERNAME=\nBITBUCKET_APP_PASSWORD=', category: 'git', description: 'Bitbucket repository management' },
  { label: 'Linear', name: 'linear', command: 'npx', args: '-y mcp-linear', env: 'LINEAR_API_KEY=', category: 'git', description: 'Linear issue tracking' },
  { label: 'Jira', name: 'jira', command: 'npx', args: '-y mcp-server-jira', env: 'JIRA_URL=\nJIRA_EMAIL=\nJIRA_API_TOKEN=', category: 'git', description: 'Jira issue management' },
  { label: 'Sentry', name: 'sentry', command: 'npx', args: '-y @modelcontextprotocol/server-sentry', env: 'SENTRY_AUTH_TOKEN=', category: 'git', description: 'Sentry error tracking' },

  // ═══════════════════════════════════════════
  // ── 파일 시스템 ──
  // ═══════════════════════════════════════════
  { label: 'Google Drive', name: 'gdrive', command: 'npx', args: '-y @modelcontextprotocol/server-gdrive', category: 'filesystem', description: 'Google Drive file access' },
  { label: 'Dropbox', name: 'dropbox', command: 'npx', args: '-y mcp-server-dropbox', env: 'DROPBOX_ACCESS_TOKEN=', category: 'filesystem', description: 'Dropbox file management' },
  { label: 'OneDrive', name: 'onedrive', command: 'npx', args: '-y mcp-server-onedrive', category: 'filesystem', description: 'OneDrive file access' },
  { label: 'S3', name: 's3', command: 'npx', args: '-y mcp-server-s3', env: 'AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nAWS_REGION=us-east-1', category: 'filesystem', description: 'AWS S3 bucket management' },
  { label: 'Box', name: 'box', command: 'npx', args: '-y @anthropics/mcp-server-box', env: 'BOX_DEVELOPER_TOKEN=', category: 'filesystem', description: 'Box file management' },

  // ═══════════════════════════════════════════
  // ── 데이터베이스 ──
  // ═══════════════════════════════════════════
  { label: 'PostgreSQL', name: 'postgres', command: 'npx', args: '-y @modelcontextprotocol/server-postgres postgresql://localhost/mydb', category: 'database', description: 'PostgreSQL DB queries' },
  { label: 'SQLite', name: 'sqlite', command: 'npx', args: '-y @modelcontextprotocol/server-sqlite --db-path ./data.db', category: 'database', description: 'SQLite DB management' },
  { label: 'MySQL', name: 'mysql', command: 'npx', args: '-y mcp-server-mysql', env: 'MYSQL_HOST=localhost\nMYSQL_USER=root\nMYSQL_PASSWORD=\nMYSQL_DATABASE=', category: 'database', description: 'MySQL DB queries' },
  { label: 'MongoDB', name: 'mongodb', command: 'npx', args: '-y mcp-server-mongodb', env: 'MONGODB_URI=mongodb://localhost:27017', category: 'database', description: 'MongoDB queries/management' },
  { label: 'Redis', name: 'redis', command: 'npx', args: '-y @modelcontextprotocol/server-redis', env: 'REDIS_URL=redis://localhost:6379', category: 'database', description: 'Redis key-value management' },
  { label: 'Supabase', name: 'supabase', command: 'npx', args: '-y mcp-server-supabase', env: 'SUPABASE_URL=\nSUPABASE_KEY=', category: 'database', description: 'Supabase DB/Auth' },
  { label: 'Firebase', name: 'firebase', command: 'npx', args: '-y mcp-server-firebase', category: 'database', description: 'Firebase Firestore/Auth' },
  { label: 'PlanetScale', name: 'planetscale', command: 'npx', args: '-y mcp-server-planetscale', env: 'PLANETSCALE_TOKEN=', category: 'database', description: 'PlanetScale DB' },
  { label: 'Neon', name: 'neon', command: 'npx', args: '-y mcp-server-neon', env: 'NEON_API_KEY=', category: 'database', description: 'Neon Serverless Postgres' },
  { label: 'Turso', name: 'turso', command: 'npx', args: '-y mcp-server-turso', env: 'TURSO_DATABASE_URL=\nTURSO_AUTH_TOKEN=', category: 'database', description: 'Turso (LibSQL) DB' },
  { label: 'ClickHouse', name: 'clickhouse', command: 'npx', args: '-y mcp-server-clickhouse', env: 'CLICKHOUSE_URL=http://localhost:8123', category: 'database', description: 'ClickHouse analytics DB' },
  { label: 'DynamoDB', name: 'dynamodb', command: 'npx', args: '-y mcp-server-dynamodb', env: 'AWS_REGION=us-east-1', category: 'database', description: 'AWS DynamoDB' },
  { label: 'Prisma', name: 'prisma', command: 'npx', args: '-y mcp-server-prisma', category: 'database', description: 'Prisma ORM integration' },
  { label: 'Drizzle', name: 'drizzle', command: 'npx', args: '-y mcp-server-drizzle', category: 'database', description: 'Drizzle ORM integration' },
  { label: 'Elasticsearch', name: 'elasticsearch', command: 'npx', args: '-y mcp-server-elasticsearch', env: 'ELASTICSEARCH_URL=http://localhost:9200', category: 'database', description: 'Elasticsearch search/analytics' },

  // ═══════════════════════════════════════════
  // ── 검색 엔진 ──
  // ═══════════════════════════════════════════
  { label: 'Brave Search', name: 'brave-search', command: 'npx', args: '-y @modelcontextprotocol/server-brave-search', env: 'BRAVE_API_KEY=', category: 'search', description: 'Brave web search' },
  { label: 'Tavily', name: 'tavily', command: 'npx', args: '-y mcp-server-tavily', env: 'TAVILY_API_KEY=', category: 'search', description: 'Tavily AI search' },
  { label: 'Exa', name: 'exa', command: 'npx', args: '-y mcp-server-exa', env: 'EXA_API_KEY=', category: 'search', description: 'Exa AI semantic search' },
  { label: 'Google Search', name: 'google-search', command: 'npx', args: '-y mcp-server-google-search', env: 'GOOGLE_API_KEY=\nGOOGLE_CSE_ID=', category: 'search', description: 'Google Custom Search' },
  { label: 'Perplexity', name: 'perplexity', command: 'npx', args: '-y mcp-server-perplexity', env: 'PERPLEXITY_API_KEY=', category: 'search', description: 'Perplexity AI search' },
  { label: 'Serper', name: 'serper', command: 'npx', args: '-y mcp-server-serper', env: 'SERPER_API_KEY=', category: 'search', description: 'Serper Google search API' },
  { label: 'SerpAPI', name: 'serpapi', command: 'npx', args: '-y mcp-server-serpapi', env: 'SERPAPI_API_KEY=', category: 'search', description: 'SerpAPI search' },
  { label: 'Algolia', name: 'algolia', command: 'npx', args: '-y mcp-server-algolia', env: 'ALGOLIA_APP_ID=\nALGOLIA_API_KEY=', category: 'search', description: 'Algolia search index' },

  // ═══════════════════════════════════════════
  // ── 웹 / 브라우저 ──
  // ═══════════════════════════════════════════
  { label: 'Puppeteer', name: 'puppeteer', command: 'npx', args: '-y @modelcontextprotocol/server-puppeteer', category: 'automation', description: 'Browser automation/scraping' },

  { label: 'Playwright', name: 'playwright', command: 'npx', args: '-y @anthropics/mcp-server-playwright', category: 'web', description: 'Playwright browser control' },
  { label: 'Browserbase', name: 'browserbase', command: 'npx', args: '-y @anthropics/mcp-server-browserbase', env: 'BROWSERBASE_API_KEY=\nBROWSERBASE_PROJECT_ID=', category: 'web', description: 'Cloud browser' },
  { label: 'Firecrawl', name: 'firecrawl', command: 'npx', args: '-y mcp-server-firecrawl', env: 'FIRECRAWL_API_KEY=', category: 'web', description: 'Web crawling/scraping' },
  { label: 'Crawl4AI', name: 'crawl4ai', command: 'npx', args: '-y mcp-server-crawl4ai', category: 'web', description: 'AI-powered web crawling' },
  { label: 'Screenshot', name: 'screenshot', command: 'npx', args: '-y mcp-server-screenshot', category: 'web', description: 'Web page screenshots' },
  { label: 'Hyperbrowser', name: 'hyperbrowser', command: 'npx', args: '-y @anthropics/mcp-server-hyperbrowser', category: 'web', description: 'Hyperbrowser control' },
  { label: 'AgentQL', name: 'agentql', command: 'npx', args: '-y @anthropics/mcp-server-agentql', category: 'web', description: 'Structured web data extraction' },

  // ═══════════════════════════════════════════
  // ── 커뮤니케이션 ──
  // ═══════════════════════════════════════════
  { label: 'Slack', name: 'slack', command: 'npx', args: '-y @modelcontextprotocol/server-slack', env: 'SLACK_BOT_TOKEN=\nSLACK_TEAM_ID=', category: 'communication', description: 'Slack messages/channels' },
  { label: 'Discord', name: 'discord', command: 'npx', args: '-y mcp-server-discord', env: 'DISCORD_BOT_TOKEN=', category: 'communication', description: 'Discord bot integration' },
  { label: 'Telegram', name: 'telegram', command: 'npx', args: '-y mcp-server-telegram', env: 'TELEGRAM_BOT_TOKEN=', category: 'communication', description: 'Telegram messages/bots' },
  { label: 'Gmail', name: 'gmail', command: 'npx', args: '-y mcp-server-gmail', category: 'communication', description: 'Gmail read/send' },
  { label: 'Outlook', name: 'outlook', command: 'npx', args: '-y mcp-server-outlook', category: 'communication', description: 'Outlook email' },
  { label: 'Microsoft Teams', name: 'teams', command: 'npx', args: '-y mcp-server-teams', category: 'communication', description: 'Teams messages' },
  { label: 'Twilio', name: 'twilio', command: 'npx', args: '-y mcp-server-twilio', env: 'TWILIO_ACCOUNT_SID=\nTWILIO_AUTH_TOKEN=', category: 'communication', description: 'SMS/phone integration' },
  { label: 'SendGrid', name: 'sendgrid', command: 'npx', args: '-y mcp-server-sendgrid', env: 'SENDGRID_API_KEY=', category: 'communication', description: 'SendGrid email sending' },
  { label: 'WhatsApp', name: 'whatsapp', command: 'npx', args: '-y mcp-server-whatsapp', category: 'communication', description: 'WhatsApp messages' },
  { label: 'Matrix', name: 'matrix', command: 'npx', args: '-y mcp-server-matrix', category: 'communication', description: 'Matrix messenger' },

  // ═══════════════════════════════════════════
  // ── 클라우드 / 인프라 ──
  // ═══════════════════════════════════════════
  { label: 'AWS', name: 'aws', command: 'npx', args: '-y mcp-server-aws', env: 'AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nAWS_REGION=us-east-1', category: 'cloud', description: 'AWS service management' },
  { label: 'AWS CDK', name: 'aws-cdk', command: 'npx', args: '-y mcp-server-aws-cdk', category: 'cloud', description: 'AWS CDK infrastructure management' },
  { label: 'GCP', name: 'gcp', command: 'npx', args: '-y mcp-server-gcp', category: 'cloud', description: 'Google Cloud Platform' },
  { label: 'Azure', name: 'azure', command: 'npx', args: '-y mcp-server-azure', category: 'cloud', description: 'Microsoft Azure management' },
  { label: 'Cloudflare', name: 'cloudflare', command: 'npx', args: '-y mcp-server-cloudflare', env: 'CLOUDFLARE_API_TOKEN=', category: 'cloud', description: 'Cloudflare Workers/Pages' },
  { label: 'Vercel', name: 'vercel', command: 'npx', args: '-y mcp-server-vercel', env: 'VERCEL_TOKEN=', category: 'cloud', description: 'Vercel deployment/projects' },
  { label: 'Netlify', name: 'netlify', command: 'npx', args: '-y mcp-server-netlify', env: 'NETLIFY_TOKEN=', category: 'cloud', description: 'Netlify deployment management' },
  { label: 'Railway', name: 'railway', command: 'npx', args: '-y mcp-server-railway', env: 'RAILWAY_TOKEN=', category: 'cloud', description: 'Railway deployment' },
  { label: 'Fly.io', name: 'flyio', command: 'npx', args: '-y mcp-server-flyio', category: 'cloud', description: 'Fly.io app management' },
  { label: 'Render', name: 'render', command: 'npx', args: '-y mcp-server-render', env: 'RENDER_API_KEY=', category: 'cloud', description: 'Render deployment' },
  { label: 'DigitalOcean', name: 'digitalocean', command: 'npx', args: '-y mcp-server-digitalocean', env: 'DIGITALOCEAN_TOKEN=', category: 'cloud', description: 'DigitalOcean management' },
  { label: 'Kubernetes', name: 'kubernetes', command: 'npx', args: '-y mcp-server-kubernetes', category: 'cloud', description: 'K8s cluster management' },
  { label: 'Docker', name: 'docker', command: 'npx', args: '-y mcp-server-docker', category: 'cloud', description: 'Docker container management' },
  { label: 'Terraform', name: 'terraform', command: 'npx', args: '-y mcp-server-terraform', category: 'cloud', description: 'Terraform IaC management' },
  { label: 'Pulumi', name: 'pulumi', command: 'npx', args: '-y mcp-server-pulumi', category: 'cloud', description: 'Pulumi infrastructure management' },

  // ═══════════════════════════════════════════
  // ── AI / LLM ──
  // ═══════════════════════════════════════════
  { label: 'OpenAI', name: 'openai', command: 'npx', args: '-y mcp-server-openai', env: 'OPENAI_API_KEY=', category: 'ai', description: 'OpenAI API integration' },
  { label: 'Anthropic', name: 'anthropic', command: 'npx', args: '-y mcp-server-anthropic', env: 'ANTHROPIC_API_KEY=', category: 'ai', description: 'Anthropic Claude API' },
  { label: 'Ollama', name: 'ollama', command: 'npx', args: '-y mcp-server-ollama', category: 'ai', description: 'Ollama local LLM' },
  { label: 'Hugging Face', name: 'huggingface', command: 'npx', args: '-y mcp-server-huggingface', env: 'HF_TOKEN=', category: 'ai', description: 'HuggingFace models/datasets' },
  { label: 'Replicate', name: 'replicate', command: 'npx', args: '-y mcp-server-replicate', env: 'REPLICATE_API_TOKEN=', category: 'ai', description: 'Replicate AI models' },
  { label: 'Together', name: 'together', command: 'npx', args: '-y mcp-server-together', env: 'TOGETHER_API_KEY=', category: 'ai', description: 'Together AI inference' },
  { label: 'Groq', name: 'groq', command: 'npx', args: '-y mcp-server-groq', env: 'GROQ_API_KEY=', category: 'ai', description: 'Groq ultra-fast inference' },
  { label: 'Mistral', name: 'mistral', command: 'npx', args: '-y mcp-server-mistral', env: 'MISTRAL_API_KEY=', category: 'ai', description: 'Mistral AI API' },
  { label: 'Cohere', name: 'cohere', command: 'npx', args: '-y mcp-server-cohere', env: 'COHERE_API_KEY=', category: 'ai', description: 'Cohere embeddings/generation' },
  { label: 'LangChain', name: 'langchain', command: 'npx', args: '-y mcp-server-langchain', category: 'ai', description: 'LangChain agents' },
  { label: 'Pinecone', name: 'pinecone', command: 'npx', args: '-y mcp-server-pinecone', env: 'PINECONE_API_KEY=', category: 'ai', description: 'Pinecone vector DB' },
  { label: 'Weaviate', name: 'weaviate', command: 'npx', args: '-y mcp-server-weaviate', category: 'ai', description: 'Weaviate vector search' },
  { label: 'Qdrant', name: 'qdrant', command: 'npx', args: '-y mcp-server-qdrant', category: 'ai', description: 'Qdrant vector DB' },
  { label: 'ChromaDB', name: 'chromadb', command: 'npx', args: '-y mcp-server-chromadb', category: 'ai', description: 'Chroma vector DB' },

  // ═══════════════════════════════════════════
  // ── 개발 도구 ──
  // ═══════════════════════════════════════════
  { label: 'NPM', name: 'npm', command: 'npx', args: '-y mcp-server-npm', category: 'devtools', description: 'NPM package search/info' },
  { label: 'TypeScript', name: 'typescript', command: 'npx', args: '-y mcp-server-typescript', category: 'devtools', description: 'TypeScript analysis/transform' },
  { label: 'ESLint', name: 'eslint', command: 'npx', args: '-y mcp-server-eslint', category: 'devtools', description: 'ESLint lint analysis' },
  { label: 'Prettier', name: 'prettier', command: 'npx', args: '-y mcp-server-prettier', category: 'devtools', description: 'Code formatting' },
  { label: 'Webpack', name: 'webpack', command: 'npx', args: '-y mcp-server-webpack', category: 'devtools', description: 'Webpack analysis' },
  { label: 'Vite', name: 'vite', command: 'npx', args: '-y mcp-server-vite', category: 'devtools', description: 'Vite dev tools' },
  { label: 'Context7', name: 'context7', command: 'npx', args: '-y @context7/mcp', category: 'devtools', description: 'Documentation context search (up-to-date docs)' },
  { label: '21st.dev Magic', name: '21st-dev', command: 'npx', args: '-y @21st-dev/magic@latest', env: 'TWENTY_FIRST_API_KEY=', category: 'devtools', description: 'UI component generation' },
  { label: 'Storybook', name: 'storybook', command: 'npx', args: '-y mcp-server-storybook', category: 'devtools', description: 'Storybook integration' },
  { label: 'Figma', name: 'figma', command: 'npx', args: '-y mcp-server-figma', env: 'FIGMA_ACCESS_TOKEN=', category: 'design', description: 'Figma design integration' },
  { label: 'Postman', name: 'postman', command: 'npx', args: '-y mcp-server-postman', env: 'POSTMAN_API_KEY=', category: 'devtools', description: 'Postman API testing' },
  { label: 'Swagger/OpenAPI', name: 'openapi', command: 'npx', args: '-y mcp-server-openapi', category: 'devtools', description: 'OpenAPI spec analysis' },
  { label: 'GraphQL', name: 'graphql', command: 'npx', args: '-y mcp-server-graphql', category: 'devtools', description: 'GraphQL schema/queries' },
  { label: 'Nx', name: 'nx', command: 'npx', args: '-y mcp-server-nx', category: 'devtools', description: 'Nx monorepo management' },
  { label: 'Turborepo', name: 'turborepo', command: 'npx', args: '-y mcp-server-turborepo', category: 'devtools', description: 'Turborepo management' },

  // ═══════════════════════════════════════════
  // ── DevOps / CI/CD ──
  // ═══════════════════════════════════════════
  { label: 'GitHub Actions', name: 'github-actions', command: 'npx', args: '-y mcp-server-github-actions', env: 'GITHUB_TOKEN=', category: 'devops', description: 'GitHub Actions workflows' },
  { label: 'CircleCI', name: 'circleci', command: 'npx', args: '-y mcp-server-circleci', env: 'CIRCLECI_TOKEN=', category: 'devops', description: 'CircleCI pipelines' },
  { label: 'Jenkins', name: 'jenkins', command: 'npx', args: '-y mcp-server-jenkins', env: 'JENKINS_URL=\nJENKINS_USER=\nJENKINS_TOKEN=', category: 'devops', description: 'Jenkins build management' },
  { label: 'ArgoCD', name: 'argocd', command: 'npx', args: '-y mcp-server-argocd', category: 'devops', description: 'ArgoCD GitOps' },
  { label: 'Datadog', name: 'datadog', command: 'npx', args: '-y mcp-server-datadog', env: 'DD_API_KEY=\nDD_APP_KEY=', category: 'devops', description: 'Datadog monitoring' },
  { label: 'PagerDuty', name: 'pagerduty', command: 'npx', args: '-y mcp-server-pagerduty', env: 'PAGERDUTY_API_KEY=', category: 'devops', description: 'PagerDuty incidents' },
  { label: 'Grafana', name: 'grafana', command: 'npx', args: '-y mcp-server-grafana', env: 'GRAFANA_URL=\nGRAFANA_API_KEY=', category: 'devops', description: 'Grafana dashboards' },
  { label: 'Prometheus', name: 'prometheus', command: 'npx', args: '-y mcp-server-prometheus', env: 'PROMETHEUS_URL=http://localhost:9090', category: 'devops', description: 'Prometheus metrics' },
  { label: 'Helm', name: 'helm', command: 'npx', args: '-y mcp-server-helm', category: 'devops', description: 'Helm chart management' },
  { label: 'Ansible', name: 'ansible', command: 'npx', args: '-y mcp-server-ansible', category: 'devops', description: 'Ansible automation' },

  // ═══════════════════════════════════════════
  // ── 테스트 ──
  // ═══════════════════════════════════════════
  { label: 'Playwright Test', name: 'playwright-test', command: 'npx', args: '-y @anthropics/mcp-server-playwright-test', category: 'testing', description: 'Playwright E2E testing' },
  { label: 'Jest', name: 'jest', command: 'npx', args: '-y mcp-server-jest', category: 'testing', description: 'Jest test runner' },
  { label: 'Cypress', name: 'cypress', command: 'npx', args: '-y mcp-server-cypress', category: 'testing', description: 'Cypress E2E testing' },
  { label: 'Vitest', name: 'vitest', command: 'npx', args: '-y mcp-server-vitest', category: 'testing', description: 'Vitest testing' },
  { label: 'Lighthouse', name: 'lighthouse', command: 'npx', args: '-y mcp-server-lighthouse', category: 'testing', description: 'Lighthouse performance audit' },
  { label: 'Appium', name: 'appium', command: 'npx', args: '-y mcp-server-appium', category: 'testing', description: 'Mobile app testing' },

  // ═══════════════════════════════════════════
  // ── 모니터링 / 로깅 ──
  // ═══════════════════════════════════════════
  { label: 'New Relic', name: 'newrelic', command: 'npx', args: '-y mcp-server-newrelic', env: 'NEW_RELIC_API_KEY=', category: 'monitoring', description: 'New Relic APM' },
  { label: 'Logstash', name: 'logstash', command: 'npx', args: '-y mcp-server-logstash', category: 'monitoring', description: 'Logstash log processing' },
  { label: 'Splunk', name: 'splunk', command: 'npx', args: '-y mcp-server-splunk', env: 'SPLUNK_URL=\nSPLUNK_TOKEN=', category: 'monitoring', description: 'Splunk log analysis' },
  { label: 'Raygun', name: 'raygun', command: 'npx', args: '-y mcp-server-raygun', env: 'RAYGUN_API_KEY=', category: 'monitoring', description: 'Raygun error monitoring' },
  { label: 'Uptime Robot', name: 'uptimerobot', command: 'npx', args: '-y mcp-server-uptimerobot', env: 'UPTIMEROBOT_API_KEY=', category: 'monitoring', description: 'Uptime monitoring' },

  // ═══════════════════════════════════════════
  // ── 보안 ──
  // ═══════════════════════════════════════════
  { label: 'Snyk', name: 'snyk', command: 'npx', args: '-y mcp-server-snyk', env: 'SNYK_TOKEN=', category: 'security', description: 'Security vulnerability scan' },
  { label: 'SonarQube', name: 'sonarqube', command: 'npx', args: '-y mcp-server-sonarqube', env: 'SONARQUBE_URL=\nSONARQUBE_TOKEN=', category: 'security', description: 'Code quality/security analysis' },
  { label: 'Dependabot', name: 'dependabot', command: 'npx', args: '-y mcp-server-dependabot', category: 'security', description: 'Dependency security updates' },
  { label: 'OWASP ZAP', name: 'owasp-zap', command: 'npx', args: '-y mcp-server-owasp-zap', category: 'security', description: 'OWASP ZAP web security scan' },
  { label: 'Vault', name: 'vault', command: 'npx', args: '-y mcp-server-vault', env: 'VAULT_ADDR=\nVAULT_TOKEN=', category: 'security', description: 'HashiCorp Vault secrets' },
  { label: '1Password', name: '1password', command: 'npx', args: '-y mcp-server-1password', category: 'security', description: '1Password secret management' },
  { label: 'Semgrep', name: 'semgrep', command: 'npx', args: '-y mcp-server-semgrep', category: 'security', description: 'Semgrep static analysis' },

  // ═══════════════════════════════════════════
  // ── 생산성 ──
  // ═══════════════════════════════════════════
  { label: 'Notion', name: 'notion', command: 'npx', args: '-y mcp-server-notion', env: 'NOTION_API_KEY=', category: 'productivity', description: 'Notion pages/DB' },
  { label: 'Obsidian', name: 'obsidian', command: 'npx', args: '-y mcp-server-obsidian', category: 'productivity', description: 'Obsidian note search' },
  { label: 'Todoist', name: 'todoist', command: 'npx', args: '-y mcp-server-todoist', env: 'TODOIST_API_TOKEN=', category: 'productivity', description: 'Todoist task management' },
  { label: 'Trello', name: 'trello', command: 'npx', args: '-y mcp-server-trello', env: 'TRELLO_API_KEY=\nTRELLO_TOKEN=', category: 'productivity', description: 'Trello board management' },
  { label: 'Asana', name: 'asana', command: 'npx', args: '-y mcp-server-asana', env: 'ASANA_ACCESS_TOKEN=', category: 'productivity', description: 'Asana project management' },
  { label: 'Monday', name: 'monday', command: 'npx', args: '-y mcp-server-monday', env: 'MONDAY_API_KEY=', category: 'productivity', description: 'Monday.com boards' },
  { label: 'Airtable', name: 'airtable', command: 'npx', args: '-y mcp-server-airtable', env: 'AIRTABLE_API_KEY=', category: 'productivity', description: 'Airtable DB/sheets' },
  { label: 'Google Sheets', name: 'google-sheets', command: 'npx', args: '-y mcp-server-google-sheets', category: 'productivity', description: 'Google Sheets read/write' },
  { label: 'Google Calendar', name: 'google-calendar', command: 'npx', args: '-y mcp-server-google-calendar', category: 'productivity', description: 'Google Calendar management' },
  { label: 'Google Docs', name: 'google-docs', command: 'npx', args: '-y mcp-server-google-docs', category: 'productivity', description: 'Google Docs documents' },
  { label: 'Confluence', name: 'confluence', command: 'npx', args: '-y mcp-server-confluence', env: 'CONFLUENCE_URL=\nCONFLUENCE_EMAIL=\nCONFLUENCE_API_TOKEN=', category: 'productivity', description: 'Confluence wiki' },
  { label: 'Basecamp', name: 'basecamp', command: 'npx', args: '-y mcp-server-basecamp', category: 'productivity', description: 'Basecamp projects' },
  { label: 'ClickUp', name: 'clickup', command: 'npx', args: '-y mcp-server-clickup', env: 'CLICKUP_API_KEY=', category: 'productivity', description: 'ClickUp task management' },
  { label: 'Coda', name: 'coda', command: 'npx', args: '-y mcp-server-coda', env: 'CODA_API_KEY=', category: 'productivity', description: 'Coda docs/automation' },
  { label: 'Roam Research', name: 'roam', command: 'npx', args: '-y mcp-server-roam', category: 'productivity', description: 'Roam Research notes' },
  { label: 'Apple Notes', name: 'apple-notes', command: 'npx', args: '-y mcp-server-apple-notes', category: 'productivity', description: 'Apple Notes access' },
  { label: 'Apple Reminders', name: 'apple-reminders', command: 'npx', args: '-y mcp-server-apple-reminders', category: 'productivity', description: 'Apple Reminders' },

  // ═══════════════════════════════════════════
  // ── 데이터 처리 ──
  // ═══════════════════════════════════════════
  { label: 'Pandas', name: 'pandas', command: 'uvx', args: 'mcp-server-pandas', category: 'data', description: 'Pandas data analysis' },
  { label: 'DuckDB', name: 'duckdb', command: 'npx', args: '-y mcp-server-duckdb', category: 'data', description: 'DuckDB analytics queries' },
  { label: 'BigQuery', name: 'bigquery', command: 'npx', args: '-y mcp-server-bigquery', category: 'data', description: 'Google BigQuery analytics' },
  { label: 'Snowflake', name: 'snowflake', command: 'npx', args: '-y mcp-server-snowflake', env: 'SNOWFLAKE_ACCOUNT=\nSNOWFLAKE_USER=\nSNOWFLAKE_PASSWORD=', category: 'data', description: 'Snowflake data warehouse' },
  { label: 'Apache Kafka', name: 'kafka', command: 'npx', args: '-y mcp-server-kafka', env: 'KAFKA_BROKERS=localhost:9092', category: 'data', description: 'Kafka message streams' },
  { label: 'RabbitMQ', name: 'rabbitmq', command: 'npx', args: '-y mcp-server-rabbitmq', env: 'RABBITMQ_URL=amqp://localhost', category: 'data', description: 'RabbitMQ message queue' },
  { label: 'CSV/Excel', name: 'csv-excel', command: 'npx', args: '-y mcp-server-csv', category: 'data', description: 'CSV/Excel file processing' },
  { label: 'JSON', name: 'json', command: 'npx', args: '-y mcp-server-json', category: 'data', description: 'JSON data transform/analysis' },
  { label: 'GraphQL Mesh', name: 'graphql-mesh', command: 'npx', args: '-y mcp-server-graphql-mesh', category: 'data', description: 'GraphQL data mesh' },
  { label: 'Airbyte', name: 'airbyte', command: 'npx', args: '-y mcp-server-airbyte', category: 'data', description: 'Airbyte data integration' },

  // ═══════════════════════════════════════════
  // ── 문서 ──
  // ═══════════════════════════════════════════
  { label: 'MDN', name: 'mdn', command: 'npx', args: '-y mcp-server-mdn', category: 'docs', description: 'MDN Web Docs search' },
  { label: 'StackOverflow', name: 'stackoverflow', command: 'npx', args: '-y mcp-server-stackoverflow', category: 'docs', description: 'StackOverflow search' },
  { label: 'DevDocs', name: 'devdocs', command: 'npx', args: '-y mcp-server-devdocs', category: 'docs', description: 'DevDocs API documentation' },
  { label: 'ReadTheDocs', name: 'readthedocs', command: 'npx', args: '-y mcp-server-readthedocs', category: 'docs', description: 'Read the Docs documentation' },
  { label: 'Man Pages', name: 'man', command: 'npx', args: '-y mcp-server-man', category: 'docs', description: 'Unix man pages' },

  // ═══════════════════════════════════════════
  // ── 미디어 ──
  // ═══════════════════════════════════════════
  { label: 'Sharp (Image)', name: 'sharp', command: 'npx', args: '-y mcp-server-sharp', category: 'media', description: 'Image processing/conversion' },
  { label: 'FFmpeg', name: 'ffmpeg', command: 'npx', args: '-y mcp-server-ffmpeg', category: 'media', description: 'Video/audio processing' },
  { label: 'YouTube', name: 'youtube', command: 'npx', args: '-y mcp-server-youtube', env: 'YOUTUBE_API_KEY=', category: 'media', description: 'YouTube search/info' },
  { label: 'Spotify', name: 'spotify', command: 'npx', args: '-y mcp-server-spotify', env: 'SPOTIFY_CLIENT_ID=\nSPOTIFY_CLIENT_SECRET=', category: 'media', description: 'Spotify music data' },
  { label: 'Cloudinary', name: 'cloudinary', command: 'npx', args: '-y mcp-server-cloudinary', env: 'CLOUDINARY_URL=', category: 'media', description: 'Cloudinary images/videos' },
  { label: 'ElevenLabs', name: 'elevenlabs', command: 'npx', args: '-y mcp-server-elevenlabs', env: 'ELEVENLABS_API_KEY=', category: 'media', description: 'ElevenLabs TTS voice' },
  { label: 'Dall-E', name: 'dalle', command: 'npx', args: '-y mcp-server-dalle', env: 'OPENAI_API_KEY=', category: 'media', description: 'DALL-E image generation' },
  { label: 'Stability AI', name: 'stability', command: 'npx', args: '-y mcp-server-stability', env: 'STABILITY_API_KEY=', category: 'media', description: 'Stable Diffusion images' },

  // ═══════════════════════════════════════════
  // ── API 연동 ──
  // ═══════════════════════════════════════════
  { label: 'Stripe', name: 'stripe', command: 'npx', args: '-y mcp-server-stripe', env: 'STRIPE_SECRET_KEY=', category: 'finance', description: 'Stripe payments/subscriptions' },
  { label: 'Shopify', name: 'shopify', command: 'npx', args: '-y mcp-server-shopify', env: 'SHOPIFY_STORE_URL=\nSHOPIFY_ACCESS_TOKEN=', category: 'api', description: 'Shopify store' },
  { label: 'Twitter/X', name: 'twitter', command: 'npx', args: '-y mcp-server-twitter', env: 'TWITTER_BEARER_TOKEN=', category: 'social', description: 'Twitter/X API' },
  { label: 'Reddit', name: 'reddit', command: 'npx', args: '-y mcp-server-reddit', category: 'social', description: 'Reddit posts/comments' },
  { label: 'HackerNews', name: 'hackernews', command: 'npx', args: '-y mcp-server-hackernews', category: 'api', description: 'Hacker News search' },
  { label: 'Wikipedia', name: 'wikipedia', command: 'npx', args: '-y mcp-server-wikipedia', category: 'api', description: 'Wikipedia search' },
  { label: 'Weather', name: 'weather', command: 'npx', args: '-y mcp-server-weather', env: 'OPENWEATHER_API_KEY=', category: 'api', description: 'Weather info API' },
  { label: 'Maps/Geocoding', name: 'maps', command: 'npx', args: '-y @modelcontextprotocol/server-google-maps', env: 'GOOGLE_MAPS_API_KEY=', category: 'maps', description: 'Google Maps location' },
  { label: 'Zendesk', name: 'zendesk', command: 'npx', args: '-y mcp-server-zendesk', env: 'ZENDESK_URL=\nZENDESK_EMAIL=\nZENDESK_TOKEN=', category: 'api', description: 'Zendesk customer support' },
  { label: 'Intercom', name: 'intercom', command: 'npx', args: '-y mcp-server-intercom', env: 'INTERCOM_ACCESS_TOKEN=', category: 'api', description: 'Intercom chat/support' },
  { label: 'Salesforce', name: 'salesforce', command: 'npx', args: '-y mcp-server-salesforce', category: 'api', description: 'Salesforce CRM' },
  { label: 'HubSpot', name: 'hubspot', command: 'npx', args: '-y mcp-server-hubspot', env: 'HUBSPOT_ACCESS_TOKEN=', category: 'api', description: 'HubSpot CRM/marketing' },
  { label: 'Mailchimp', name: 'mailchimp', command: 'npx', args: '-y mcp-server-mailchimp', env: 'MAILCHIMP_API_KEY=', category: 'api', description: 'Mailchimp email marketing' },
  { label: 'Twitch', name: 'twitch', command: 'npx', args: '-y mcp-server-twitch', env: 'TWITCH_CLIENT_ID=\nTWITCH_CLIENT_SECRET=', category: 'api', description: 'Twitch streaming' },
  { label: 'Instagram', name: 'instagram', command: 'npx', args: '-y mcp-server-instagram', category: 'social', description: 'Instagram API' },
  { label: 'LinkedIn', name: 'linkedin', command: 'npx', args: '-y mcp-server-linkedin', category: 'social', description: 'LinkedIn profiles/posts' },
  { label: 'Product Hunt', name: 'producthunt', command: 'npx', args: '-y mcp-server-producthunt', category: 'api', description: 'Product Hunt search' },
  { label: 'Unsplash', name: 'unsplash', command: 'npx', args: '-y mcp-server-unsplash', env: 'UNSPLASH_ACCESS_KEY=', category: 'api', description: 'Unsplash free images' },
  { label: 'OpenWeatherMap', name: 'openweathermap', command: 'npx', args: '-y mcp-server-openweathermap', env: 'OPENWEATHER_API_KEY=', category: 'api', description: 'Weather data' },
  { label: 'CoinGecko', name: 'coingecko', command: 'npx', args: '-y mcp-server-coingecko', category: 'blockchain', description: 'Cryptocurrency prices' },
  { label: 'Alpha Vantage', name: 'alphavantage', command: 'npx', args: '-y mcp-server-alphavantage', env: 'ALPHAVANTAGE_API_KEY=', category: 'finance', description: 'Stock/financial data' },

  // ═══════════════════════════════════════════
  // ── 분석 ──
  // ═══════════════════════════════════════════
  { label: 'Google Analytics', name: 'google-analytics', command: 'npx', args: '-y mcp-server-google-analytics', category: 'analytics', description: 'GA4 analytics data' },
  { label: 'Mixpanel', name: 'mixpanel', command: 'npx', args: '-y mcp-server-mixpanel', env: 'MIXPANEL_TOKEN=', category: 'analytics', description: 'Mixpanel event analytics' },
  { label: 'Amplitude', name: 'amplitude', command: 'npx', args: '-y mcp-server-amplitude', env: 'AMPLITUDE_API_KEY=', category: 'analytics', description: 'Amplitude analytics' },
  { label: 'PostHog', name: 'posthog', command: 'npx', args: '-y mcp-server-posthog', env: 'POSTHOG_API_KEY=\nPOSTHOG_HOST=', category: 'analytics', description: 'PostHog product analytics' },
  { label: 'Segment', name: 'segment', command: 'npx', args: '-y mcp-server-segment', env: 'SEGMENT_WRITE_KEY=', category: 'analytics', description: 'Segment customer data' },
  { label: 'Plausible', name: 'plausible', command: 'npx', args: '-y mcp-server-plausible', env: 'PLAUSIBLE_API_KEY=\nPLAUSIBLE_SITE_ID=', category: 'analytics', description: 'Plausible privacy analytics' },

  // ═══════════════════════════════════════════
  // ── 기타 ──
  // ═══════════════════════════════════════════
  { label: 'Cron', name: 'cron', command: 'npx', args: '-y mcp-server-cron', category: 'other', description: 'Cron job scheduling' },
  { label: 'Shell', name: 'shell', command: 'npx', args: '-y mcp-server-shell', category: 'other', description: 'Shell command execution' },
  { label: 'SSH', name: 'ssh', command: 'npx', args: '-y mcp-server-ssh', category: 'other', description: 'SSH remote server access' },
  { label: 'PDF', name: 'pdf', command: 'npx', args: '-y mcp-server-pdf', category: 'other', description: 'PDF read/convert' },
  { label: 'QR Code', name: 'qrcode', command: 'npx', args: '-y mcp-server-qrcode', category: 'other', description: 'QR code generation' },
  { label: 'OCR', name: 'ocr', command: 'npx', args: '-y mcp-server-ocr', category: 'other', description: 'Extract text from images' },
  { label: 'Translate', name: 'translate', command: 'npx', args: '-y mcp-server-translate', category: 'other', description: 'Multilingual translation' },
  { label: 'Currency', name: 'currency', command: 'npx', args: '-y mcp-server-currency', category: 'finance', description: 'Currency conversion' },
  { label: 'Calculator', name: 'calculator', command: 'npx', args: '-y mcp-server-calculator', category: 'other', description: 'Math calculation' },
  { label: 'Regex', name: 'regex', command: 'npx', args: '-y mcp-server-regex', category: 'other', description: 'Regex testing/generation' },
  { label: 'UUID', name: 'uuid', command: 'npx', args: '-y mcp-server-uuid', category: 'other', description: 'UUID generation' },
  { label: 'Lorem Ipsum', name: 'lorem', command: 'npx', args: '-y mcp-server-lorem', category: 'other', description: 'Dummy text generation' },
  { label: 'Markdownify', name: 'markdownify', command: 'npx', args: '-y mcp-server-markdownify', category: 'other', description: 'HTML to Markdown conversion' },
  { label: 'Mermaid', name: 'mermaid', command: 'npx', args: '-y mcp-server-mermaid', category: 'other', description: 'Mermaid diagrams' },
  { label: 'PlantUML', name: 'plantuml', command: 'npx', args: '-y mcp-server-plantuml', category: 'other', description: 'PlantUML diagrams' },
  { label: 'Excalidraw', name: 'excalidraw', command: 'npx', args: '-y mcp-server-excalidraw', category: 'design', description: 'Excalidraw drawing' },
  { label: 'Mailtrap', name: 'mailtrap', command: 'npx', args: '-y mcp-server-mailtrap', env: 'MAILTRAP_API_TOKEN=', category: 'other', description: 'Mailtrap email testing' },
  { label: 'Resend', name: 'resend', command: 'npx', args: '-y mcp-server-resend', env: 'RESEND_API_KEY=', category: 'other', description: 'Resend email sending' },
  { label: 'Apify', name: 'apify', command: 'npx', args: '-y @anthropics/mcp-server-apify', env: 'APIFY_TOKEN=', category: 'other', description: 'Apify 6000+ crawlers' },
  { label: 'Zapier', name: 'zapier', command: 'npx', args: '-y mcp-server-zapier', env: 'ZAPIER_API_KEY=', category: 'automation', description: 'Zapier automation' },
  { label: 'IFTTT', name: 'ifttt', command: 'npx', args: '-y mcp-server-ifttt', category: 'automation', description: 'IFTTT automation' },
  { label: 'n8n', name: 'n8n', command: 'npx', args: '-y mcp-server-n8n', category: 'automation', description: 'n8n workflows' },
  { label: 'Make', name: 'make', command: 'npx', args: '-y mcp-server-make', category: 'automation', description: 'Make.com automation' },
  { label: 'Home Assistant', name: 'homeassistant', command: 'npx', args: '-y mcp-server-homeassistant', env: 'HA_URL=\nHA_TOKEN=', category: 'other', description: 'Home Assistant smart home' },
  { label: 'RSS', name: 'rss', command: 'npx', args: '-y mcp-server-rss', category: 'other', description: 'RSS feed subscribe/read' },
  { label: 'IMAP Email', name: 'imap', command: 'npx', args: '-y mcp-server-imap', env: 'IMAP_HOST=\nIMAP_USER=\nIMAP_PASSWORD=', category: 'other', description: 'IMAP email reading' },
  { label: 'DNS', name: 'dns', command: 'npx', args: '-y mcp-server-dns', category: 'other', description: 'DNS lookup/analysis' },
  { label: 'IP Geolocation', name: 'ip-geo', command: 'npx', args: '-y mcp-server-ip-geolocation', category: 'maps', description: 'IP geolocation lookup' },
  { label: 'WHOIS', name: 'whois', command: 'npx', args: '-y mcp-server-whois', category: 'other', description: 'WHOIS domain lookup' },
  { label: 'Wayback Machine', name: 'wayback', command: 'npx', args: '-y mcp-server-wayback', category: 'other', description: 'Internet Archive' },
  { label: 'Archive.org', name: 'archive', command: 'npx', args: '-y mcp-server-archive', category: 'other', description: 'Archive.org search' },
  { label: 'Pocket', name: 'pocket', command: 'npx', args: '-y mcp-server-pocket', env: 'POCKET_CONSUMER_KEY=\nPOCKET_ACCESS_TOKEN=', category: 'other', description: 'Pocket bookmarks' },
  { label: 'Raindrop', name: 'raindrop', command: 'npx', args: '-y mcp-server-raindrop', env: 'RAINDROP_TOKEN=', category: 'other', description: 'Raindrop.io bookmarks' },
  { label: 'Readwise', name: 'readwise', command: 'npx', args: '-y mcp-server-readwise', env: 'READWISE_TOKEN=', category: 'other', description: 'Readwise highlights' },
  { label: 'Calendly', name: 'calendly', command: 'npx', args: '-y mcp-server-calendly', env: 'CALENDLY_API_KEY=', category: 'other', description: 'Calendly scheduling' },
  { label: 'Cal.com', name: 'calcom', command: 'npx', args: '-y mcp-server-calcom', env: 'CALCOM_API_KEY=', category: 'other', description: 'Cal.com scheduling' },
  { label: 'Zoom', name: 'zoom', command: 'npx', args: '-y mcp-server-zoom', env: 'ZOOM_CLIENT_ID=\nZOOM_CLIENT_SECRET=', category: 'other', description: 'Zoom meeting management' },
  { label: 'Google Meet', name: 'google-meet', command: 'npx', args: '-y mcp-server-google-meet', category: 'other', description: 'Google Meet management' },
  { label: 'Loom', name: 'loom', command: 'npx', args: '-y mcp-server-loom', category: 'other', description: 'Loom video management' },
  { label: 'Canva', name: 'canva', command: 'npx', args: '-y mcp-server-canva', category: 'design', description: 'Canva design' },
  { label: 'Vercel AI', name: 'vercel-ai', command: 'npx', args: '-y mcp-server-vercel-ai', category: 'other', description: 'Vercel AI SDK' },
  { label: 'Cursor Rules', name: 'cursor-rules', command: 'npx', args: '-y mcp-server-cursor-rules', category: 'other', description: 'Cursor rules management' },
  { label: 'Docker Compose', name: 'docker-compose', command: 'npx', args: '-y mcp-server-docker-compose', category: 'other', description: 'Docker Compose management' },
  { label: 'Nginx', name: 'nginx', command: 'npx', args: '-y mcp-server-nginx', category: 'other', description: 'Nginx config management' },
  { label: 'Caddy', name: 'caddy', command: 'npx', args: '-y mcp-server-caddy', category: 'other', description: 'Caddy web server' },
  { label: 'Let\'s Encrypt', name: 'letsencrypt', command: 'npx', args: '-y mcp-server-letsencrypt', category: 'other', description: 'SSL certificate management' },
  { label: 'Heroku', name: 'heroku', command: 'npx', args: '-y mcp-server-heroku', env: 'HEROKU_API_KEY=', category: 'other', description: 'Heroku app management' },
  { label: 'Deno', name: 'deno', command: 'npx', args: '-y mcp-server-deno', category: 'other', description: 'Deno runtime' },
  { label: 'Bun', name: 'bun-mcp', command: 'npx', args: '-y mcp-server-bun', category: 'other', description: 'Bun runtime' },
  { label: 'WakaTime', name: 'wakatime', command: 'npx', args: '-y mcp-server-wakatime', env: 'WAKATIME_API_KEY=', category: 'other', description: 'WakaTime coding time' },
  { label: 'CodeClimate', name: 'codeclimate', command: 'npx', args: '-y mcp-server-codeclimate', category: 'other', description: 'CodeClimate code quality' },
  { label: 'Codecov', name: 'codecov', command: 'npx', args: '-y mcp-server-codecov', category: 'other', description: 'Codecov coverage' },

  // ═══════════════════════════════════════════
  // ── 추가 서버 (300+ 달성) ──
  // ═══════════════════════════════════════════

  // ── 공식/검증된 패키지 (verified npm packages) ──
  { label: 'Playwright (Official)', name: 'playwright-official', command: 'npx', args: '-y @playwright/mcp', category: 'web', description: 'Playwright official MCP (accessibility snapshots)' },
  { label: 'GitHub (Official)', name: 'github-official', command: 'npx', args: '-y @github/mcp-server', env: 'GITHUB_PERSONAL_ACCESS_TOKEN=', category: 'git', description: 'GitHub official MCP server' },
  { label: 'Notion (Official)', name: 'notion-official', command: 'npx', args: '-y @notionhq/notion-mcp-server', env: 'NOTION_API_KEY=', category: 'productivity', description: 'Notion official MCP server' },
  { label: 'Stripe (Official)', name: 'stripe-official', command: 'npx', args: '-y @stripe/mcp --api-key=YOUR_KEY', category: 'finance', description: 'Stripe official payment API' },
  { label: 'Sentry (Official)', name: 'sentry-official', command: 'npx', args: '-y @sentry/mcp-server@latest', env: 'SENTRY_AUTH_TOKEN=', category: 'monitoring', description: 'Sentry official error tracking' },
  { label: 'Supabase (Official)', name: 'supabase-official', command: 'npx', args: '-y @supabase/mcp-server-supabase@latest', env: 'SUPABASE_ACCESS_TOKEN=\nSUPABASE_PROJECT_REF=', category: 'database', description: 'Supabase official DB/Auth' },
  { label: 'Upstash', name: 'upstash', command: 'npx', args: '-y @upstash/mcp-server@latest', env: 'UPSTASH_EMAIL=\nUPSTASH_API_KEY=', category: 'database', description: 'Upstash Redis/QStash/Vector' },
  { label: 'Context7 (Official)', name: 'context7-official', command: 'npx', args: '-y @upstash/context7-mcp@latest', category: 'devtools', description: 'Context7 documentation context (up-to-date docs)' },
  { label: 'Railway (Official)', name: 'railway-official', command: 'npx', args: '-y @railway/mcp-server', category: 'cloud', description: 'Railway official deployment management' },
  { label: 'Netlify (Official)', name: 'netlify-official', command: 'npx', args: '-y @netlify/mcp-server', env: 'NETLIFY_AUTH_TOKEN=', category: 'cloud', description: 'Netlify official deployment/build' },
  { label: 'Cloudflare (Official)', name: 'cloudflare-official', command: 'npx', args: '-y @cloudflare/mcp-server-cloudflare', env: 'CLOUDFLARE_API_TOKEN=', category: 'cloud', description: 'Cloudflare official Workers/R2/DNS' },
  { label: 'ElevenLabs (Official)', name: 'elevenlabs-official', command: 'npx', args: '-y @elevenlabs/mcp-server', env: 'ELEVENLABS_API_KEY=', category: 'media', description: 'ElevenLabs official TTS/voice cloning' },
  { label: 'Pulumi (Official)', name: 'pulumi-official', command: 'npx', args: '-y @pulumi/mcp-server@latest stdio', env: 'PULUMI_ACCESS_TOKEN=', category: 'devops', description: 'Pulumi official IaC automation' },
  { label: 'Twilio (Official)', name: 'twilio-official', command: 'npx', args: '-y @twilio-alpha/mcp', env: 'TWILIO_ACCOUNT_SID=\nTWILIO_AUTH_TOKEN=', category: 'communication', description: 'Twilio official SMS/voice' },
  { label: 'Perplexity (Official)', name: 'perplexity-official', command: 'npx', args: '-y @perplexity-ai/mcp-server', env: 'PERPLEXITY_API_KEY=', category: 'search', description: 'Perplexity official Sonar search' },
  { label: 'Mailgun (Official)', name: 'mailgun-official', command: 'npx', args: '-y @mailgun/mcp-server', env: 'MAILGUN_API_KEY=\nMAILGUN_DOMAIN=', category: 'communication', description: 'Mailgun official email sending' },

  // ── 추가 데이터베이스 ──
  { label: 'Neo4j', name: 'neo4j', command: 'npx', args: '-y mcp-neo4j', env: 'NEO4J_URI=bolt://localhost:7687\nNEO4J_USER=neo4j\nNEO4J_PASSWORD=', category: 'database', description: 'Neo4j graph DB queries' },
  { label: 'SingleStore', name: 'singlestore', command: 'npx', args: '-y @singlestore/mcp-server', env: 'SINGLESTORE_HOST=\nSINGLESTORE_USER=\nSINGLESTORE_PASSWORD=', category: 'database', description: 'SingleStore DB platform' },
  { label: 'Astra DB', name: 'astra-db', command: 'npx', args: '-y @datastax/astra-db-mcp', env: 'ASTRA_DB_APPLICATION_TOKEN=', category: 'database', description: 'DataStax Astra NoSQL DB' },
  { label: 'MotherDuck', name: 'motherduck', command: 'npx', args: '-y @motherduck/mcp-server', env: 'MOTHERDUCK_TOKEN=', category: 'database', description: 'MotherDuck cloud DuckDB' },
  { label: 'Tinybird', name: 'tinybird', command: 'npx', args: '-y @tinybirdco/mcp-tinybird', env: 'TINYBIRD_TOKEN=', category: 'database', description: 'Tinybird serverless ClickHouse' },
  { label: 'Convex', name: 'convex', command: 'npx', args: '-y @convex-dev/mcp-server', category: 'database', description: 'Convex app queries/management' },
  { label: 'Apache Doris', name: 'doris', command: 'npx', args: '-y mcp-server-doris', env: 'DORIS_HOST=\nDORIS_PORT=9030\nDORIS_USER=root', category: 'database', description: 'Apache Doris MPP data warehouse' },
  { label: 'OceanBase', name: 'oceanbase', command: 'npx', args: '-y @oceanbase/mcp-server', env: 'OCEANBASE_HOST=\nOCEANBASE_USER=\nOCEANBASE_PASSWORD=', category: 'database', description: 'OceanBase distributed DB' },
  { label: 'StarRocks', name: 'starrocks', command: 'npx', args: '-y mcp-server-starrocks', env: 'STARROCKS_HOST=\nSTARROCKS_PORT=9030', category: 'database', description: 'StarRocks analytics DB' },
  { label: 'Meilisearch', name: 'meilisearch', command: 'npx', args: '-y mcp-server-meilisearch', env: 'MEILI_HOST=http://localhost:7700\nMEILI_MASTER_KEY=', category: 'database', description: 'Meilisearch full-text search' },

  // ── 추가 클라우드 ──
  { label: 'AWS CDK (Official)', name: 'aws-cdk-official', command: 'npx', args: '-y @awslabs/mcp-server-aws-cdk', category: 'cloud', description: 'AWS CDK official guidance/Nag rules' },
  { label: 'AWS Docs', name: 'aws-docs', command: 'npx', args: '-y @awslabs/mcp-server-aws-documentation', category: 'cloud', description: 'AWS documentation search' },
  { label: 'AWS Cost', name: 'aws-cost', command: 'npx', args: '-y @awslabs/mcp-server-cost-analysis', category: 'cloud', description: 'AWS cost analysis' },
  { label: 'Gcore Cloud', name: 'gcore', command: 'npx', args: '-y @gcore/mcp-server', env: 'GCORE_API_KEY=', category: 'cloud', description: 'Gcore cloud services' },
  { label: 'Aiven', name: 'aiven', command: 'npx', args: '-y @aiven/mcp-server', env: 'AIVEN_TOKEN=', category: 'cloud', description: 'Aiven cloud (Kafka/PG/Redis)' },
  { label: '4EVERLAND', name: '4everland', command: 'npx', args: '-y @4everland/mcp-server', category: 'cloud', description: 'Distributed network deployment' },
  { label: 'EdgeOne Pages', name: 'edgeone', command: 'npx', args: '-y @tencent/edgeone-pages-mcp', category: 'cloud', description: 'Tencent EdgeOne Pages deployment' },
  { label: 'Hostinger', name: 'hostinger', command: 'npx', args: '-y @hostinger/mcp-server', env: 'HOSTINGER_API_TOKEN=', category: 'cloud', description: 'Hostinger hosting management' },
  { label: 'LocalStack', name: 'localstack', command: 'npx', args: '-y localstack-mcp-server', env: 'LOCALSTACK_API_KEY=', category: 'cloud', description: 'LocalStack local AWS emulation' },

  // ── 추가 DevOps ──
  { label: 'Buildkite', name: 'buildkite', command: 'npx', args: '-y @buildkite/mcp-server', env: 'BUILDKITE_API_TOKEN=', category: 'devops', description: 'Buildkite pipelines/builds' },
  { label: 'Harness', name: 'harness', command: 'npx', args: '-y @harness/mcp-server', env: 'HARNESS_API_KEY=', category: 'devops', description: 'Harness pipelines/logs' },
  { label: 'Azure DevOps', name: 'azure-devops', command: 'npx', args: '-y @azure/devops-mcp-server', env: 'AZURE_DEVOPS_ORG=\nAZURE_DEVOPS_PAT=', category: 'devops', description: 'Azure DevOps work items/builds' },
  { label: 'Stakpak', name: 'stakpak', command: 'npx', args: '-y @stakpak/mcp-server', category: 'devops', description: 'Generate Terraform/K8s/GH Actions' },

  // ── 추가 AI ──
  { label: 'MindBridge', name: 'mindbridge', command: 'npx', args: '-y @pinkpixel/mindbridge', env: 'OPENAI_API_KEY=', category: 'ai', description: 'Multi-LLM integration (OpenAI/Anthropic/Ollama)' },
  { label: 'Langfuse', name: 'langfuse', command: 'npx', args: '-y @langfuse/mcp-server', env: 'LANGFUSE_PUBLIC_KEY=\nLANGFUSE_SECRET_KEY=', category: 'ai', description: 'LLM prompt management/evaluation' },
  { label: 'AgentOps', name: 'agentops', command: 'npx', args: '-y @agentops/mcp-server', env: 'AGENTOPS_API_KEY=', category: 'ai', description: 'AI agent observability' },
  { label: 'Chronulus AI', name: 'chronulus', command: 'npx', args: '-y @chronulus/mcp-server', env: 'CHRONULUS_API_KEY=', category: 'ai', description: 'AI prediction/forecasting agent' },

  // ── 추가 검색/웹 ──
  { label: 'Omnisearch', name: 'omnisearch', command: 'npx', args: '-y mcp-omnisearch', env: 'TAVILY_API_KEY=\nBRAVE_API_KEY=', category: 'search', description: 'Multi-search-engine integration (Tavily/Brave/Kagi)' },
  { label: 'Oxylabs', name: 'oxylabs', command: 'npx', args: '-y @oxylabs/mcp-server', env: 'OXYLABS_USERNAME=\nOXYLABS_PASSWORD=', category: 'web', description: 'Web scraping + dynamic rendering' },
  { label: 'Bright Data', name: 'bright-data', command: 'npx', args: '-y @brightdata/mcp', env: 'BRIGHT_DATA_API_KEY=', category: 'web', description: 'Web data collection/extraction' },
  { label: 'Notte', name: 'notte', command: 'npx', args: '-y @notte-ai/mcp-server', category: 'web', description: 'Web AI agent + cloud browser' },

  // ── 추가 미디어 ──
  { label: 'Fal.ai', name: 'fal-ai', command: 'npx', args: '-y fal-mcp-server', env: 'FAL_KEY=', category: 'media', description: 'Fal.ai images/video/music (600+ models)' },
  { label: 'ImageGen', name: 'imagegen', command: 'npx', args: '-y imagegen-mcp-server', env: 'OPENAI_API_KEY=', category: 'media', description: 'DALL-E/Imagen/Flux image generation' },
  { label: 'Mux Video', name: 'mux', command: 'npx', args: '-y @mux/mcp-server', env: 'MUX_TOKEN_ID=\nMUX_TOKEN_SECRET=', category: 'media', description: 'Mux video upload/streaming' },
  { label: 'YouTube Transcript', name: 'youtube-transcript', command: 'npx', args: '-y mcp-server-youtube-transcript', category: 'media', description: 'YouTube captions/transcript extraction' },
  { label: 'Blender', name: 'blender', command: 'npx', args: '-y blender-mcp', category: 'media', description: 'Blender 3D modeling integration' },
  { label: 'ECharts', name: 'echarts', command: 'npx', args: '-y echarts-mcp-server', category: 'media', description: 'ECharts visual chart generation' },
  { label: 'Manim', name: 'manim', command: 'npx', args: '-y manim-mcp', category: 'media', description: 'Manim math animation' },
  { label: 'DINO-X', name: 'dinox', command: 'npx', args: '-y @dinox/mcp-server', env: 'DINOX_API_KEY=', category: 'media', description: 'Computer vision/object detection' },
  { label: 'PaddleOCR', name: 'paddleocr', command: 'npx', args: '-y paddleocr-mcp-server', category: 'media', description: 'Enterprise-grade OCR/document parsing' },

  // ── 추가 생산성 ──
  { label: 'Linear (Official)', name: 'linear-official', command: 'npx', args: '-y @larryhudson/linear-mcp-server', env: 'LINEAR_API_KEY=', category: 'productivity', description: 'Linear issue/project management' },
  { label: 'Plane', name: 'plane', command: 'npx', args: '-y @plane/mcp-server', env: 'PLANE_API_KEY=', category: 'productivity', description: 'Plane project management' },
  { label: 'Taskade', name: 'taskade', command: 'npx', args: '-y @taskade/mcp-server', env: 'TASKADE_API_KEY=', category: 'productivity', description: 'Taskade tasks/workflows' },
  { label: 'Todoist (Official)', name: 'todoist-official', command: 'npx', args: '-y mcp-remote https://ai.todoist.net/mcp', category: 'productivity', description: 'Todoist official task management' },
  { label: 'Google Workspace', name: 'google-workspace', command: 'npx', args: '-y @pegasusheavy/google-mcp', env: 'GOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=', category: 'productivity', description: 'Gmail/Drive/Docs/Sheets/Calendar integration' },
  { label: 'Atlassian (51 tools)', name: 'atlassian-full', command: 'npx', args: '-y @xuanxt/atlassian-mcp', env: 'ATLASSIAN_SITE_NAME=\nATLASSIAN_USER_EMAIL=\nATLASSIAN_API_TOKEN=', category: 'productivity', description: 'Confluence/Jira integration with 51 tools' },
  { label: 'Fibery', name: 'fibery', command: 'npx', args: '-y @fibery/mcp-server', env: 'FIBERY_API_KEY=\nFIBERY_WORKSPACE=', category: 'productivity', description: 'Fibery workspace management' },
  { label: 'Rember', name: 'rember', command: 'npx', args: '-y @rember/mcp-server', category: 'productivity', description: 'Spaced-repetition flashcard generation' },
  { label: 'SlideSpeak', name: 'slidespeak', command: 'npx', args: '-y @slidespeak/mcp-server', env: 'SLIDESPEAK_API_KEY=', category: 'productivity', description: 'AI presentation/PPT generation' },

  // ── 추가 모니터링 ──
  { label: 'Grafana (Official)', name: 'grafana-official', command: 'npx', args: '-y @grafana/mcp-server', env: 'GRAFANA_URL=\nGRAFANA_API_KEY=', category: 'monitoring', description: 'Grafana official dashboards/queries' },
  { label: 'Axiom', name: 'axiom', command: 'npx', args: '-y @axiom/mcp-server', env: 'AXIOM_TOKEN=', category: 'monitoring', description: 'Axiom logs/traces/events' },
  { label: 'Last9', name: 'last9', command: 'npx', args: '-y @last9/mcp-server', env: 'LAST9_API_KEY=', category: 'monitoring', description: 'Production logs/metrics/traces' },
  { label: 'Dash0', name: 'dash0', command: 'npx', args: '-y @dash0/mcp-server', env: 'DASH0_API_KEY=', category: 'monitoring', description: 'OpenTelemetry incident investigation' },
  { label: 'ilert', name: 'ilert', command: 'npx', args: '-y @ilert/mcp-server', env: 'ILERT_API_KEY=', category: 'monitoring', description: 'ilert incident management' },

  // ── 추가 보안 ──
  { label: 'Semgrep (Official)', name: 'semgrep-official', command: 'npx', args: '-y @semgrep/mcp-server', env: 'SEMGREP_APP_TOKEN=', category: 'security', description: 'Semgrep official SAST security scan' },
  { label: 'Bitwarden', name: 'bitwarden', command: 'npx', args: '-y @bitwarden/mcp-server', category: 'security', description: 'Bitwarden password management' },
  { label: 'Cycode', name: 'cycode', command: 'npx', args: '-y @cycode/mcp-server', env: 'CYCODE_API_KEY=', category: 'security', description: 'SAST/SCA/secrets/IaC scanning' },
  { label: 'Auth0', name: 'auth0', command: 'npx', args: '-y @auth0/mcp-server', env: 'AUTH0_DOMAIN=\nAUTH0_CLIENT_ID=\nAUTH0_CLIENT_SECRET=', category: 'security', description: 'Auth0 authentication/identity management' },
  { label: 'Security Scanner', name: 'security-scanner', command: 'npx', args: '-y agent-security-scanner-mcp', category: 'security', description: 'Prompt injection firewall/package verification' },

  // ── 추가 테스트 ──
  { label: 'BrowserStack', name: 'browserstack', command: 'npx', args: '-y @browserstack/mcp-server', env: 'BROWSERSTACK_USERNAME=\nBROWSERSTACK_ACCESS_KEY=', category: 'testing', description: 'BrowserStack cross-browser testing' },
  { label: 'Currents', name: 'currents', command: 'npx', args: '-y @currents/mcp-server', env: 'CURRENTS_API_KEY=', category: 'testing', description: 'Playwright test failure analysis' },
  { label: 'Debugg AI', name: 'debugg-ai', command: 'npx', args: '-y @debugg-ai/mcp-server', env: 'DEBUGG_API_KEY=', category: 'testing', description: '0-config E2E testing' },

  // ── 추가 API/기타 ──
  { label: 'PayPal', name: 'paypal', command: 'npx', args: '-y @paypal/mcp-server', env: 'PAYPAL_CLIENT_ID=\nPAYPAL_CLIENT_SECRET=', category: 'finance', description: 'PayPal payment API' },
  { label: 'CoinGecko (Official)', name: 'coingecko-official', command: 'npx', args: '-y @coingecko/mcp-server', env: 'COINGECKO_API_KEY=', category: 'blockchain', description: 'CoinGecko cryptocurrency data' },
  { label: 'Thirdweb', name: 'thirdweb', command: 'npx', args: '-y @thirdweb/mcp-server', env: 'THIRDWEB_SECRET_KEY=', category: 'blockchain', description: 'Read/write across 2000+ blockchains' },
  { label: 'DexPaprika', name: 'dexpaprika', command: 'npx', args: '-y @dexpaprika/mcp-server', category: 'blockchain', description: 'DEX analytics across 20+ blockchains' },
  { label: 'Mapbox', name: 'mapbox', command: 'npx', args: '-y @mapbox/mcp-server', env: 'MAPBOX_ACCESS_TOKEN=', category: 'maps', description: 'Mapbox geocoding/routing/POI' },
  { label: 'Globalping', name: 'globalping', command: 'npx', args: '-y @globalping/mcp-server', category: 'api', description: 'ping/traceroute/MTR/DNS networking' },
  { label: 'FHIR (Healthcare)', name: 'fhir', command: 'npx', args: '-y fhir-mcp-server', env: 'FHIR_SERVER_URL=', category: 'api', description: 'FHIR healthcare data API' },
  { label: 'Pipedream', name: 'pipedream', command: 'npx', args: '-y @pipedream/mcp-server', env: 'PIPEDREAM_API_KEY=', category: 'automation', description: 'Pipedream workflow integration' },
  { label: '0nmcp (26 Services)', name: '0nmcp', command: 'npx', args: '-y 0nmcp', category: 'api', description: '26 integrations including Stripe/Slack/SendGrid' },
  { label: 'Kiwi.com', name: 'kiwi', command: 'npx', args: '-y @kiwi/mcp-server', env: 'KIWI_API_KEY=', category: 'other', description: 'Flight search/booking' },
  { label: 'OP.GG', name: 'opgg', command: 'npx', args: '-y @opgg/mcp-server', category: 'other', description: 'LoL/TFT/Valorant game data' },
  { label: 'ThingsBoard IoT', name: 'thingsboard', command: 'npx', args: '-y @thingsboard/mcp-server', env: 'THINGSBOARD_URL=\nTHINGSBOARD_TOKEN=', category: 'other', description: 'ThingsBoard IoT platform' },
  { label: 'Tldv Meeting', name: 'tldv', command: 'npx', args: '-y @tldv/mcp-server', env: 'TLDV_API_KEY=', category: 'communication', description: 'Google Meet/Zoom/Teams meetings' },

  // ── 추가 데이터/문서/도구 ──
  { label: 'Graphlit', name: 'graphlit', command: 'npx', args: '-y @graphlit/mcp-server', env: 'GRAPHLIT_API_KEY=', category: 'data', description: 'Slack/Gmail/podcasts to searchable projects' },
  { label: 'RSS Feed', name: 'rss-feed', command: 'npx', args: '-y feed-mcp', category: 'data', description: 'RSS/Atom/JSON Feed bridge' },
  { label: 'dbt', name: 'dbt', command: 'npx', args: '-y @dbt-labs/mcp-server', env: 'DBT_TOKEN=', category: 'data', description: 'dbt metadata discovery' },
  { label: 'Mermaid MCP', name: 'mermaid-mcp', command: 'npx', args: '-y mermaid-mcp-server', category: 'docs', description: 'Mermaid diagram generation (22+ types)' },
  { label: 'MCP Remote', name: 'mcp-remote', command: 'npx', args: '-y mcp-remote@latest', category: 'devtools', description: 'HTTP/SSE remote MCP server proxy' },
  { label: 'Plugged.in Proxy', name: 'pluggedin', command: 'npx', args: '-y @pluggedin/mcp-proxy', category: 'devtools', description: 'Multiple MCP servers into a single interface' },
  { label: 'MCPFinder', name: 'mcpfinder', command: 'npx', args: '-y @mcpfinder/server', category: 'devtools', description: 'MCP server registry search' },
  { label: 'Smithery CLI', name: 'smithery', command: 'npx', args: '-y @smithery/cli', category: 'devtools', description: 'Smithery MCP server install/management' },
  { label: 'Desktop Commander', name: 'desktop-commander', command: 'npx', args: '-y @wonderwhy-er/desktop-commander@latest', category: 'devtools', description: 'Terminal/file system/diff editing' },
  { label: 'macOS Tools', name: 'macos-tools', command: 'npx', args: '-y @macos-tools/mcp-server', category: 'devtools', description: 'macOS system tools suite' },
  { label: 'Jira (aashari)', name: 'jira-aashari', command: 'npx', args: '-y @aashari/mcp-server-atlassian-jira', env: 'ATLASSIAN_SITE_NAME=\nATLASSIAN_USER_EMAIL=\nATLASSIAN_API_TOKEN=', category: 'productivity', description: 'Jira Cloud issues/sprints/JQL' },
  { label: 'Confluence (aashari)', name: 'confluence-aashari', command: 'npx', args: '-y @aashari/mcp-server-atlassian-confluence', env: 'ATLASSIAN_SITE_NAME=\nATLASSIAN_USER_EMAIL=\nATLASSIAN_API_TOKEN=', category: 'productivity', description: 'Confluence Cloud pages/spaces' },
  { label: 'Bitbucket (aashari)', name: 'bitbucket-aashari', command: 'npx', args: '-y @aashari/mcp-server-atlassian-bitbucket', env: 'ATLASSIAN_SITE_NAME=\nATLASSIAN_USER_EMAIL=\nATLASSIAN_API_TOKEN=', category: 'git', description: 'Bitbucket Cloud repositories/PRs' },
  { label: 'Gitee', name: 'gitee', command: 'npx', args: '-y @gitee/mcp-server', env: 'GITEE_ACCESS_TOKEN=', category: 'git', description: 'Gitee repositories/issues/PRs' },
  { label: 'IMAP Email', name: 'imap-email', command: 'npx', args: '-y mcp-mail-server', env: 'IMAP_HOST=\nIMAP_USER=\nIMAP_PASSWORD=\nSMTP_HOST=', category: 'communication', description: 'IMAP/SMTP email (lightweight)' },
  { label: 'Resend (Official)', name: 'resend-official', command: 'npx', args: '-y resend-mcp-server', env: 'RESEND_API_KEY=', category: 'communication', description: 'Resend official email sending' },

  // ── Aggregators ──
  { label: 'Pipedream', name: 'pipedream', command: 'npx', args: '-y @pipedream/mcp', env: 'PIPEDREAM_API_KEY=', category: 'automation', description: '2500+ API integrations (8000+ tools)' },
  { label: 'MetaMCP', name: 'metamcp', command: 'npx', args: '-y metamcp', category: 'devtools', description: 'Unified middleware MCP server (GUI management)' },
  { label: 'Anyquery', name: 'anyquery', command: 'npx', args: '-y @anyquery/mcp-server', category: 'database', description: 'Query 40+ apps with SQL' },

  // ── Browser Automation ──
  { label: 'Browserbase', name: 'browserbase', command: 'npx', args: '-y @browserbasehq/mcp-server', env: 'BROWSERBASE_API_KEY=\nBROWSERBASE_PROJECT_ID=', category: 'web', description: 'Cloud browser automation' },
  { label: 'BrowserMCP', name: 'browsermcp', command: 'npx', args: '-y @anthropic/browsermcp', category: 'web', description: 'Local Chrome automation' },
  { label: 'Fetcher MCP', name: 'fetcher-mcp', command: 'npx', args: '-y @anthropic/fetcher-mcp', category: 'web', description: 'Playwright headless web scraping' },
  { label: 'YouTube Transcript', name: 'youtube-transcript', command: 'npx', args: '-y @anthropic/youtube-transcript-mcp', category: 'web', description: 'YouTube captions/transcript extraction' },

  // ── Databases (추가) ──
  { label: 'Supabase', name: 'supabase', command: 'npx', args: '-y @supabase/mcp-server', env: 'SUPABASE_URL=\nSUPABASE_KEY=', category: 'database', description: 'Official Supabase MCP (AI assistant)' },
  { label: 'ClickHouse', name: 'clickhouse', command: 'npx', args: '-y @clickhouse/mcp-server', env: 'CLICKHOUSE_URL=', category: 'database', description: 'ClickHouse analytics DB' },
  { label: 'Neo4j', name: 'neo4j', command: 'npx', args: '-y @neo4j/mcp-server', env: 'NEO4J_URI=\nNEO4J_USER=\nNEO4J_PASSWORD=', category: 'database', description: 'Neo4j graph DB' },
  { label: 'Neon Postgres', name: 'neon', command: 'npx', args: '-y @neondatabase/mcp-server-neon', env: 'NEON_API_KEY=', category: 'database', description: 'Neon serverless Postgres' },
  { label: 'DuckDB', name: 'duckdb', command: 'npx', args: '-y @ktanaka101/mcp-server-duckdb', category: 'database', description: 'DuckDB embedded analytics DB' },
  { label: 'Firebase MCP', name: 'firebase', command: 'npx', args: '-y firebase-mcp', env: 'FIREBASE_PROJECT_ID=', category: 'database', description: 'Firebase Auth/Firestore/Storage' },
  { label: 'Pinecone', name: 'pinecone', command: 'npx', args: '-y @sirmews/mcp-pinecone', env: 'PINECONE_API_KEY=', category: 'database', description: 'Pinecone vector search' },
  { label: 'Qdrant', name: 'qdrant', command: 'npx', args: '-y @qdrant/mcp-server-qdrant', env: 'QDRANT_URL=', category: 'database', description: 'Qdrant vector DB' },
  { label: 'Chroma', name: 'chroma', command: 'npx', args: '-y @chroma-core/mcp-server', category: 'database', description: 'Chroma vector DB (RAG)' },
  { label: 'Prisma MCP', name: 'prisma-mcp', command: 'npx', args: '-y @prisma/mcp', category: 'database', description: 'Prisma Postgres management' },
  { label: 'Elasticsearch', name: 'elasticsearch', command: 'npx', args: '-y elasticsearch-mcp-server', env: 'ELASTICSEARCH_URL=', category: 'database', description: 'Elasticsearch search/analytics' },
  { label: 'InfluxDB', name: 'influxdb', command: 'npx', args: '-y @influxdata/mcp-server', env: 'INFLUXDB_TOKEN=', category: 'database', description: 'InfluxDB time-series DB' },
  { label: 'Snowflake', name: 'snowflake', command: 'npx', args: '-y @snowflake-labs/mcp-server', env: 'SNOWFLAKE_ACCOUNT=\nSNOWFLAKE_USER=\nSNOWFLAKE_PASSWORD=', category: 'database', description: 'Snowflake data warehouse' },
  { label: 'Confluent Kafka', name: 'confluent-kafka', command: 'npx', args: '-y @confluentinc/mcp-server', env: 'CONFLUENT_API_KEY=\nCONFLUENT_API_SECRET=', category: 'database', description: 'Confluent Kafka messaging' },

  // ── Cloud & DevOps ──
  { label: 'AWS Labs MCP', name: 'aws-labs', command: 'npx', args: '-y @awslabs/mcp-server', env: 'AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=', category: 'cloud', description: 'Official AWS MCP server' },
  { label: 'Terraform', name: 'terraform', command: 'npx', args: '-y @hashicorp/terraform-mcp-server', category: 'devops', description: 'Official Terraform IaC' },
  { label: 'Pulumi', name: 'pulumi', command: 'npx', args: '-y @pulumi/mcp-server', env: 'PULUMI_ACCESS_TOKEN=', category: 'devops', description: 'Pulumi infrastructure automation' },
  { label: 'LocalStack', name: 'localstack', command: 'npx', args: '-y localstack-mcp-server', category: 'devops', description: 'Local AWS environment management' },
  { label: 'Docker MCP', name: 'docker-mcp', command: 'npx', args: '-y @ckreiling/mcp-server-docker', category: 'devops', description: 'Docker container management' },
  { label: 'Docker Hub', name: 'docker-hub', command: 'npx', args: '-y @docker/hub-mcp', category: 'devops', description: 'Official Docker Hub MCP' },

  // ── Dev Tools (추가) ──
  { label: 'Magic MCP (21st.dev)', name: 'magic-mcp', command: 'npx', args: '-y @21st-dev/magic-mcp', category: 'design', description: 'Automatic UI component generation' },
  { label: 'Figma Context', name: 'figma-context', command: 'npx', args: '-y @anthropic/figma-context-mcp', env: 'FIGMA_ACCESS_TOKEN=', category: 'design', description: 'Figma design to code' },
  { label: 'Context7', name: 'context7', command: 'npx', args: '-y @upstash/context7-mcp', category: 'devtools', description: 'Reference up-to-date code documentation' },
  { label: 'Postman MCP', name: 'postman-mcp', command: 'npx', args: '-y @delano/postman-mcp-server', env: 'POSTMAN_API_KEY=', category: 'devtools', description: 'Postman API testing' },
  { label: 'SonarQube', name: 'sonarqube', command: 'npx', args: '-y sonarqube-mcp-server', env: 'SONARQUBE_URL=\nSONARQUBE_TOKEN=', category: 'devtools', description: 'Code quality analysis' },
  { label: 'PostHog', name: 'posthog', command: 'npx', args: '-y @posthog/mcp', env: 'POSTHOG_API_KEY=', category: 'analytics', description: 'Analytics/feature flags/error tracking' },
  { label: 'Langfuse', name: 'langfuse', command: 'npx', args: '-y @langfuse/mcp-server', env: 'LANGFUSE_PUBLIC_KEY=\nLANGFUSE_SECRET_KEY=', category: 'ai', description: 'LLM app prompt management' },
  { label: 'shadcn/ui MCP', name: 'shadcn-ui-mcp', command: 'npx', args: '-y shadcn-ui-mcp-server', category: 'devtools', description: 'shadcn/ui v4 component access' },
  { label: 'Package Version', name: 'package-version', command: 'npx', args: '-y mcp-package-version', category: 'devtools', description: 'Latest stable package version recommendations' },
  { label: 'Next.js DevTools', name: 'next-devtools', command: 'npx', args: '-y @vercel/next-devtools-mcp', category: 'devtools', description: 'Official Next.js MCP (Vercel)' },
  { label: 'Task Master', name: 'task-master', command: 'npx', args: '-y task-master-mcp', category: 'devtools', description: 'AI-powered development task management' },
  { label: 'MCP Language Server', name: 'mcp-language-server', command: 'npx', args: '-y mcp-language-server', category: 'devtools', description: 'Definition/reference/rename semantic tools' },
  { label: 'OpenAPI to MCP', name: 'openapi-mcp', command: 'npx', args: '-y openapi-mcp-server', category: 'devtools', description: 'Connect REST APIs via OpenAPI spec' },
  { label: 'Storybook MCP', name: 'storybook-mcp', command: 'npx', args: '-y @storybook/addon-mcp', category: 'devtools', description: 'Storybook component stories' },
  { label: 'CircleCI MCP', name: 'circleci-mcp', command: 'npx', args: '-y @circleci/mcp-server', env: 'CIRCLECI_TOKEN=', category: 'devops', description: 'CircleCI build failure fixes' },
  { label: 'Buildkite MCP', name: 'buildkite-mcp', command: 'npx', args: '-y @buildkite/mcp-server', env: 'BUILDKITE_TOKEN=', category: 'devops', description: 'Official Buildkite CI/CD' },

  // ── Search (추가) ──
  { label: 'Tavily Search', name: 'tavily', command: 'npx', args: '-y @tavily/mcp-server', env: 'TAVILY_API_KEY=', category: 'search', description: 'Tavily AI search API' },
  { label: 'DuckDuckGo', name: 'duckduckgo', command: 'npx', args: '-y duckduckgo-mcp-server', category: 'search', description: 'DuckDuckGo web search (free)' },
  { label: 'SearXNG', name: 'searxng', command: 'npx', args: '-y mcp-searxng', env: 'SEARXNG_URL=', category: 'search', description: 'SearXNG meta search engine' },
  { label: 'ArXiv', name: 'arxiv', command: 'npx', args: '-y arxiv-mcp-server', category: 'search', description: 'ArXiv paper search' },
  { label: 'Hacker News', name: 'hacker-news', command: 'npx', args: '-y mcp-hn', category: 'search', description: 'Hacker News search/top stories' },
  { label: 'SerpAPI', name: 'serpapi', command: 'npx', args: '-y @serpapi/mcp-server', env: 'SERPAPI_API_KEY=', category: 'search', description: 'Multi-engine search results' },
  { label: 'Wolfram Alpha', name: 'wolfram-alpha', command: 'npx', args: '-y mcp-wolframalpha', env: 'WOLFRAM_APP_ID=', category: 'search', description: 'Wolfram Alpha computational knowledge' },
  { label: 'BrightData', name: 'brightdata', command: 'npx', args: '-y @luminati-io/brightdata-mcp', env: 'BRIGHTDATA_API_KEY=', category: 'search', description: 'Web data scraping' },
  { label: 'Apify', name: 'apify', command: 'npx', args: '-y @apify/mcp-server', env: 'APIFY_TOKEN=', category: 'search', description: '6000+ web scraping tools' },

  // ── Communication (추가) ──
  { label: 'WhatsApp MCP', name: 'whatsapp', command: 'npx', args: '-y whatsapp-mcp', category: 'communication', description: 'WhatsApp message/contact search' },
  { label: 'Discord MCP', name: 'discord-mcp', command: 'npx', args: '-y discord-mcp-server', env: 'DISCORD_BOT_TOKEN=', category: 'communication', description: 'Discord bot integration' },
  { label: 'Twitter/X', name: 'twitter-x', command: 'npx', args: '-y mcp-twikit', category: 'social', description: 'Twitter search/timeline' },
  { label: 'Bluesky', name: 'bluesky', command: 'npx', args: '-y bluesky-mcp-server', category: 'social', description: 'Bluesky social integration' },
  { label: 'MS Teams MCP', name: 'ms-teams', command: 'npx', args: '-y mcp-teams-server', env: 'TEAMS_APP_ID=\nTEAMS_APP_SECRET=', category: 'communication', description: 'Microsoft Teams messaging' },
  { label: 'Infobip', name: 'infobip', command: 'npx', args: '-y @infobip/mcp-server', env: 'INFOBIP_API_KEY=', category: 'communication', description: 'Global SMS/WhatsApp/email' },

  // ── Security ──
  { label: 'VirusTotal', name: 'virustotal', command: 'npx', args: '-y mcp-virustotal', env: 'VIRUSTOTAL_API_KEY=', category: 'security', description: 'URL/file malware scan' },
  { label: 'Shodan', name: 'shodan', command: 'npx', args: '-y mcp-shodan', env: 'SHODAN_API_KEY=', category: 'security', description: 'IP/device/CVE search' },
  { label: 'NIST CVE', name: 'nist-cve', command: 'npx', args: '-y vuln-nist-mcp-server', category: 'security', description: 'NIST vulnerability DB lookup' },

  // ── Knowledge & Memory ──
  { label: 'Obsidian MCP', name: 'obsidian', command: 'npx', args: '-y mcp-obsidian', category: 'docs', description: 'Obsidian vault AI bridge' },
  { label: 'Mem0', name: 'mem0', command: 'npx', args: '-y @mem0ai/mcp-server', env: 'MEM0_API_KEY=', category: 'ai', description: 'Coding pattern/preference memory' },
  { label: 'Graphlit', name: 'graphlit', command: 'npx', args: '-y @graphlit/mcp-server', env: 'GRAPHLIT_TOKEN=', category: 'ai', description: 'Slack/Discord/Drive ingest + search' },

  // ── File & Document ──
  { label: 'MarkItDown', name: 'markitdown', command: 'npx', args: '-y @microsoft/markitdown-mcp', category: 'docs', description: 'File to Markdown conversion (Microsoft)' },
  { label: 'Pandoc MCP', name: 'pandoc-mcp', command: 'npx', args: '-y mcp-pandoc', category: 'docs', description: 'Document format conversion (MD/HTML/PDF)' },
  { label: 'Box MCP', name: 'box', command: 'npx', args: '-y @box/mcp-server', env: 'BOX_JWT_CONFIG=', category: 'filesystem', description: 'Box file access' },

  // ── Finance ──
  { label: 'Yahoo Finance', name: 'yahoo-finance', command: 'npx', args: '-y yfinance-mcp', category: 'finance', description: 'Yahoo Finance stocks/crypto' },
  { label: 'Polygon.io', name: 'polygon-io', command: 'npx', args: '-y @polygon-io/mcp-server', env: 'POLYGON_API_KEY=', category: 'finance', description: 'Financial market data API' },
  { label: 'Stripe MCP', name: 'stripe-mcp', command: 'npx', args: '-y @stripe/mcp-server', env: 'STRIPE_SECRET_KEY=', category: 'finance', description: 'Stripe payments/subscriptions/customers' },
  { label: 'CoinMarketCap', name: 'coinmarketcap', command: 'npx', args: '-y coinmarket-mcp-server', env: 'CMC_API_KEY=', category: 'blockchain', description: 'Cryptocurrency prices/rankings' },

  // ── Data & Analytics ──
  { label: 'Jupyter MCP', name: 'jupyter', command: 'npx', args: '-y @datalayer/jupyter-mcp-server', category: 'ai', description: 'Jupyter notebook server' },
  { label: 'dbt MCP', name: 'dbt', command: 'npx', args: '-y @dbt-labs/mcp-server', env: 'DBT_TOKEN=', category: 'database', description: 'Official dbt data build tool' },
  { label: 'Tinybird', name: 'tinybird', command: 'npx', args: '-y @tinybirdco/mcp-server', env: 'TINYBIRD_TOKEN=', category: 'analytics', description: 'Tinybird real-time analytics' },
  { label: 'Amplitude', name: 'amplitude', command: 'npx', args: '-y amplitude-mcp', env: 'AMPLITUDE_API_KEY=', category: 'analytics', description: 'Product analytics integration' },
  { label: 'GrowthBook', name: 'growthbook', command: 'npx', args: '-y @growthbook/mcp', env: 'GROWTHBOOK_API_KEY=', category: 'analytics', description: 'Feature flags/experiments' },

  // ── Marketing ──
  { label: 'Meta Ads', name: 'meta-ads', command: 'npx', args: '-y meta-ads-mcp', env: 'META_ACCESS_TOKEN=', category: 'social', description: 'Meta/Facebook ads automation' },
  { label: 'Google Ads', name: 'google-ads', command: 'npx', args: '-y google-ads-mcp-server', env: 'GOOGLE_ADS_CLIENT_ID=\nGOOGLE_ADS_CLIENT_SECRET=', category: 'api', description: 'Google Ads data/management' },

  // ── Monitoring (추가) ──
  { label: 'Grafana MCP', name: 'grafana', command: 'npx', args: '-y @grafana/mcp-server', env: 'GRAFANA_URL=\nGRAFANA_TOKEN=', category: 'monitoring', description: 'Grafana dashboards/alerts' },
  { label: 'Dynatrace', name: 'dynatrace', command: 'npx', args: '-y @dynatrace/mcp-server', env: 'DYNATRACE_URL=\nDYNATRACE_TOKEN=', category: 'monitoring', description: 'AI-powered observability' },
  { label: 'Logfire', name: 'logfire', command: 'npx', args: '-y @pydantic/logfire-mcp', env: 'LOGFIRE_TOKEN=', category: 'monitoring', description: 'OpenTelemetry traces/metrics' },

  // ── Multimedia ──
  { label: 'Blender MCP', name: 'blender', command: 'npx', args: '-y blender-mcp-server', category: 'media', description: 'Blender 3D modeling' },
  { label: 'FFmpeg MCP', name: 'ffmpeg-mcp', command: 'npx', args: '-y ffmpeg-mcp', category: 'media', description: 'FFmpeg video editing' },
  { label: 'Fal.ai', name: 'fal-ai', command: 'npx', args: '-y fal-mcp-server', env: 'FAL_KEY=', category: 'ai', description: 'AI image/video/music generation' },

  // ═══════════════════════════════════════════
  // ── 가이드 추출 서버 (mcp-guide.md) ──
  // ═══════════════════════════════════════════

  // ── AI / LLM (가이드) ──
  { label: 'DeepL', name: 'deepl', command: 'npx', args: '-y deepl-mcp-server', env: 'DEEPL_API_KEY=', category: 'ai', description: 'DeepL AI translation/rewriting' },
  { label: 'OpenAI (pierrebrunelle)', name: 'openai-mcp', command: 'npx', args: '-y @pierrebrunelle/mcp-server-openai', env: 'OPENAI_API_KEY=', category: 'ai', description: 'OpenAI model MCP queries' },
  { label: 'Cartesia TTS', name: 'cartesia', command: 'npx', args: '-y @cartesia/mcp-server', env: 'CARTESIA_API_KEY=', category: 'ai', description: 'Cartesia TTS/voice cloning' },
  { label: 'Patronus AI', name: 'patronus-ai', command: 'npx', args: '-y @patronus-ai/mcp-server', env: 'PATRONUS_API_KEY=', category: 'ai', description: 'AI agent testing/evaluation' },
  { label: 'Atla AI', name: 'atla-ai', command: 'npx', args: '-y @atla-ai/mcp-server', env: 'ATLA_API_KEY=', category: 'ai', description: 'LLM evaluation/optimization' },

  // ── 데이터베이스 (가이드) ──
  { label: 'Airtable (domdomegg)', name: 'airtable-domdomegg', command: 'npx', args: '-y airtable-mcp-server', env: 'AIRTABLE_API_KEY=', category: 'database', description: 'Airtable DB read/write' },
  { label: 'MongoDB (Official)', name: 'mongodb-official', command: 'npx', args: '-y @mongodb-js/mongodb-mcp-server', env: 'MONGODB_URI=', category: 'database', description: 'MongoDB official MCP server' },
  { label: 'MariaDB', name: 'mariadb', command: 'npx', args: '-y @mariadb/mcp-server', env: 'MARIADB_HOST=\nMARIADB_USER=\nMARIADB_PASSWORD=', category: 'database', description: 'MariaDB official DB management' },
  { label: 'Chroma (Official)', name: 'chroma-official', command: 'npx', args: '-y @chroma-core/chroma-mcp', category: 'database', description: 'Chroma official vector DB' },
  { label: 'ClickHouse (Official)', name: 'clickhouse-official', command: 'npx', args: '-y @clickhouse/mcp-clickhouse', env: 'CLICKHOUSE_URL=', category: 'database', description: 'ClickHouse official analytics DB' },
  { label: 'Redis (Official)', name: 'redis-official', command: 'npx', args: '-y @redis/mcp-server', env: 'REDIS_URL=redis://localhost:6379', category: 'database', description: 'Redis official MCP server' },
  { label: 'Pinecone (Official)', name: 'pinecone-official', command: 'npx', args: '-y @pinecone-io/pinecone-mcp', env: 'PINECONE_API_KEY=', category: 'database', description: 'Pinecone official vector search' },
  { label: 'Upstash (Official)', name: 'upstash-official', command: 'npx', args: '-y @upstash/mcp-server', env: 'UPSTASH_EMAIL=\nUPSTASH_API_KEY=', category: 'database', description: 'Upstash official Redis/Vector' },
  { label: 'Neon (Official)', name: 'neon-official', command: 'npx', args: '-y @neondatabase/mcp-server-neon', env: 'NEON_API_KEY=', category: 'database', description: 'Neon official serverless Postgres' },
  { label: 'Neo4j (Official)', name: 'neo4j-official', command: 'npx', args: '-y @neo4j/mcp-neo4j', env: 'NEO4J_URI=\nNEO4J_USER=neo4j\nNEO4J_PASSWORD=', category: 'database', description: 'Neo4j official graph DB' },
  { label: 'Qdrant (Official)', name: 'qdrant-official', command: 'npx', args: '-y @qdrant/mcp-server-qdrant', env: 'QDRANT_URL=', category: 'database', description: 'Qdrant official vector DB' },
  { label: 'Milvus', name: 'milvus', command: 'npx', args: '-y @zilliztech/mcp-server-milvus', env: 'MILVUS_URI=', category: 'database', description: 'Milvus vector search engine' },
  { label: 'FalkorDB', name: 'falkordb', command: 'npx', args: '-y falkordb-mcp-server', env: 'FALKORDB_URI=', category: 'database', description: 'FalkorDB graph DB' },
  { label: 'YugabyteDB', name: 'yugabytedb', command: 'npx', args: '-y @yugabyte/mcp-server', env: 'YUGABYTE_HOST=', category: 'database', description: 'YugabyteDB distributed SQL' },
  { label: 'SQL Server (Official)', name: 'mssql-official', command: 'npx', args: '-y @azure/mssql-mcp-server', env: 'MSSQL_CONNECTION_STRING=', category: 'database', description: 'Microsoft SQL Server official' },
  { label: 'DBHub', name: 'dbhub', command: 'npx', args: '-y @bytebase/dbhub', category: 'database', description: 'Universal DB for MySQL/PG/MSSQL' },
  { label: 'Astra DB (Official)', name: 'astra-db-official', command: 'npx', args: '-y @datastax/astra-db-mcp', env: 'ASTRA_DB_APPLICATION_TOKEN=', category: 'database', description: 'DataStax Astra NoSQL/Vector' },

  // ── 클라우드 / 인프라 (가이드) ──
  { label: 'AWS (Official)', name: 'aws-official', command: 'npx', args: '-y @awslabs/mcp', env: 'AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=', category: 'cloud', description: 'AWS official MCP server' },
  { label: 'Azure (Official)', name: 'azure-official', command: 'npx', args: '-y @azure/mcp-server', category: 'cloud', description: 'Microsoft Azure official MCP' },
  { label: 'Cloudflare (Official)', name: 'cloudflare-mcp', command: 'npx', args: '-y @cloudflare/mcp-server-cloudflare', env: 'CLOUDFLARE_API_TOKEN=', category: 'cloud', description: 'Cloudflare official Workers/R2/D1' },
  { label: 'Google Cloud Run', name: 'google-cloud-run', command: 'npx', args: '-y @googlecloudplatform/cloud-run-mcp', category: 'cloud', description: 'Google Cloud Run deployment' },
  { label: 'Terraform (Official)', name: 'terraform-official', command: 'npx', args: '-y @hashicorp/terraform-mcp-server', category: 'cloud', description: 'HashiCorp Terraform official IaC' },
  { label: 'Pulumi (Official)', name: 'pulumi-mcp-official', command: 'npx', args: '-y @pulumi/mcp-server', env: 'PULUMI_ACCESS_TOKEN=', category: 'cloud', description: 'Pulumi official infrastructure as code' },
  { label: 'Kubernetes (Flux159)', name: 'kubernetes-flux', command: 'npx', args: '-y @flux159/mcp-server-kubernetes', category: 'cloud', description: 'K8s cluster Pods/Deployments/Services' },
  { label: 'Docker (ckreiling)', name: 'docker-ckreiling', command: 'npx', args: '-y @ckreiling/mcp-server-docker', category: 'cloud', description: 'Docker containers/images/volumes' },
  { label: 'Docker Hub (Official)', name: 'docker-hub-official', command: 'npx', args: '-y @docker/hub-mcp', category: 'cloud', description: 'Docker Hub official search/images' },
  { label: 'E2B Sandbox', name: 'e2b-sandbox', command: 'npx', args: '-y @e2b/mcp-server', env: 'E2B_API_KEY=', category: 'cloud', description: 'E2B secure sandbox code execution' },
  { label: 'Heroku (Official)', name: 'heroku-official', command: 'npx', args: '-y @heroku/heroku-mcp-server', env: 'HEROKU_API_KEY=', category: 'cloud', description: 'Heroku official app/DB management' },
  { label: 'Vercel (Official)', name: 'vercel-official', command: 'npx', args: '-y @vercel/mcp', env: 'VERCEL_TOKEN=', category: 'cloud', description: 'Vercel official deployment/logs/docs' },
  { label: 'Daytona Sandbox', name: 'daytona', command: 'npx', args: '-y @daytona/mcp-server', env: 'DAYTONA_API_KEY=', category: 'cloud', description: 'Daytona secure code sandbox' },
  { label: 'Octopus Deploy', name: 'octopus-deploy', command: 'npx', args: '-y @octopusdeploy/mcp-server', env: 'OCTOPUS_API_KEY=\nOCTOPUS_URL=', category: 'cloud', description: 'Octopus Deploy deployment management' },
  { label: 'MuleSoft', name: 'mulesoft', command: 'npx', args: '-y @mulesoft/mcp-server', category: 'cloud', description: 'MuleSoft app build/deploy' },
  { label: 'Convex (Official)', name: 'convex-official', command: 'npx', args: '-y @convex-dev/mcp-server', category: 'cloud', description: 'Convex app inspection/queries' },

  // ── 웹 / 브라우저 (가이드) ──
  { label: 'Playwright (Microsoft)', name: 'playwright-microsoft', command: 'npx', args: '-y @playwright/mcp@latest', category: 'web', description: 'Microsoft Playwright official MCP' },
  { label: 'BrowserMCP', name: 'browsermcp-official', command: 'npx', args: '-y @nicepkg/browsermcp', category: 'web', description: 'Local Chrome automation' },
  { label: 'Firecrawl (Official)', name: 'firecrawl-official', command: 'npx', args: '-y @mendableai/firecrawl-mcp-server', env: 'FIRECRAWL_API_KEY=', category: 'web', description: 'Firecrawl official web scraping' },
  { label: 'Hyperbrowser', name: 'hyperbrowser-official', command: 'npx', args: '-y @hyperbrowserai/mcp', env: 'HYPERBROWSER_API_KEY=', category: 'web', description: 'Hyperbrowser AI browser automation' },
  { label: 'Chrome DevTools', name: 'chrome-devtools', command: 'npx', args: '-y @anthropic/chrome-devtools-mcp', category: 'web', description: 'Chrome DevTools debugging' },
  { label: 'Supadata', name: 'supadata', command: 'npx', args: '-y @supadata/mcp', category: 'web', description: 'YouTube/TikTok/X web data' },
  { label: 'Jina Reader', name: 'jina-reader', command: 'npx', args: '-y mcp-jina-reader', category: 'web', description: 'Jina Reader URL→Markdown' },
  { label: 'Markdownify', name: 'markdownify-web', command: 'npx', args: '-y @zcaceres/markdownify-mcp', category: 'web', description: 'File/web to Markdown conversion' },

  // ── Git / 버전 관리 (가이드) ──
  { label: 'GitHub (Official)', name: 'github-mcp-official', command: 'npx', args: '-y @github/mcp-server', env: 'GITHUB_PERSONAL_ACCESS_TOKEN=', category: 'git', description: 'GitHub official MCP (issues/PRs/code)' },
  { label: 'GitLab (Official)', name: 'gitlab-official', command: 'npx', args: '-y @gitlab/mcp-server', env: 'GITLAB_PERSONAL_ACCESS_TOKEN=', category: 'git', description: 'GitLab official MCP server' },
  { label: 'Gitea', name: 'gitea', command: 'npx', args: '-y @gitea/mcp-server', category: 'git', description: 'Gitea repository management' },
  { label: 'JFrog', name: 'jfrog', command: 'npx', args: '-y @jfrog/mcp-jfrog', env: 'JFROG_URL=\nJFROG_TOKEN=', category: 'git', description: 'JFrog artifact/release management' },
  { label: 'Codacy', name: 'codacy', command: 'npx', args: '-y @codacy/mcp-server', env: 'CODACY_API_TOKEN=', category: 'git', description: 'Codacy code quality analysis' },
  { label: 'GitKraken', name: 'gitkraken', command: 'npx', args: '-y @gitkraken/mcp-server', category: 'git', description: 'GitKraken/Jira/GitHub/GitLab integration' },

  // ── 생산성 / 프로젝트 관리 (가이드) ──
  { label: 'Linear (Official)', name: 'linear-mcp-official', command: 'npx', args: '-y @linear/mcp-server', env: 'LINEAR_API_KEY=', category: 'productivity', description: 'Linear official issues/projects' },
  { label: 'Monday.com (Official)', name: 'monday-official', command: 'npx', args: '-y @mondaycom/mcp-server', env: 'MONDAY_API_KEY=', category: 'productivity', description: 'Monday.com official boards/items' },
  { label: 'Todoist (AI)', name: 'todoist-ai', command: 'npx', args: '-y @doist/todoist-mcp-server', env: 'TODOIST_API_TOKEN=', category: 'productivity', description: 'Todoist official task management' },
  { label: 'Shortcut', name: 'shortcut', command: 'npx', args: '-y @useshortcut/mcp-server', category: 'productivity', description: 'Shortcut projects/stories' },
  { label: 'Plane (Official)', name: 'plane-official', command: 'npx', args: '-y @makeplane/mcp-server', env: 'PLANE_API_KEY=', category: 'productivity', description: 'Plane official project management' },
  { label: 'Routine', name: 'routine', command: 'npx', args: '-y @routineco/mcp-server', category: 'productivity', description: 'Routine calendar/tasks/notes' },
  { label: 'Claude Task Master', name: 'claude-task-master', command: 'npx', args: '-y task-master-ai', category: 'productivity', description: 'AI-powered task management (PRD parsing)' },

  // ── 모니터링 (가이드) ──
  { label: 'Sentry (Official)', name: 'sentry-mcp-official', command: 'npx', args: '-y @sentry/mcp-server', env: 'SENTRY_AUTH_TOKEN=', category: 'monitoring', description: 'Sentry official error/performance tracking' },
  { label: 'Grafana (Official)', name: 'grafana-mcp-official', command: 'npx', args: '-y @grafana/mcp-server', env: 'GRAFANA_URL=\nGRAFANA_API_KEY=', category: 'monitoring', description: 'Grafana official dashboards/queries' },
  { label: 'Datadog', name: 'datadog-mcp', command: 'npx', args: '-y @datadog/mcp-server', env: 'DD_API_KEY=\nDD_APP_KEY=', category: 'monitoring', description: 'Datadog tracing/monitoring' },
  { label: 'Prometheus MCP', name: 'prometheus-mcp', command: 'npx', args: '-y @pab1it0/prometheus-mcp-server', env: 'PROMETHEUS_URL=http://localhost:9090', category: 'monitoring', description: 'Prometheus metric queries/analysis' },
  { label: 'Dynatrace (Official)', name: 'dynatrace-official', command: 'npx', args: '-y @dynatrace/mcp-server', env: 'DYNATRACE_URL=\nDYNATRACE_TOKEN=', category: 'monitoring', description: 'Dynatrace official observability' },
  { label: 'Raygun', name: 'raygun-official', command: 'npx', args: '-y @mindscapehq/mcp-server-raygun', env: 'RAYGUN_API_KEY=', category: 'monitoring', description: 'Raygun crash/real-user monitoring' },
  { label: 'PostHog (Official)', name: 'posthog-official', command: 'npx', args: '-y @posthog/mcp', env: 'POSTHOG_API_KEY=', category: 'monitoring', description: 'PostHog official analytics/feature flags' },
  { label: 'PagerDuty (Official)', name: 'pagerduty-official', command: 'npx', args: '-y @pagerduty/mcp-server', env: 'PAGERDUTY_API_KEY=', category: 'monitoring', description: 'PagerDuty official incident management' },

  // ── API / SaaS (가이드) ──
  { label: 'HubSpot (Official)', name: 'hubspot-official', command: 'npx', args: '-y @hubspot/mcp-server', env: 'HUBSPOT_ACCESS_TOKEN=', category: 'api', description: 'HubSpot official CRM data' },
  { label: 'Klaviyo', name: 'klaviyo', command: 'npx', args: '-y @klaviyo/mcp-server', env: 'KLAVIYO_API_KEY=', category: 'api', description: 'Klaviyo marketing automation' },
  { label: 'Customer.io', name: 'customer-io', command: 'npx', args: '-y @customerio/mcp-server', env: 'CUSTOMERIO_API_KEY=', category: 'api', description: 'Customer.io customer messaging' },
  { label: 'Stripe (Official)', name: 'stripe-sdk-official', command: 'npx', args: '-y @stripe/mcp --tools=all --api-key=YOUR_KEY', env: 'STRIPE_SECRET_KEY=', category: 'finance', description: 'Stripe official SDK MCP' },
  { label: 'PayPal (Official)', name: 'paypal-official', command: 'npx', args: '-y @paypal/mcp-server', env: 'PAYPAL_CLIENT_ID=\nPAYPAL_CLIENT_SECRET=', category: 'finance', description: 'PayPal official payment API' },
  { label: 'Polygon.io (Official)', name: 'polygon-official', command: 'npx', args: '-y @polygon-io/mcp-server', env: 'POLYGON_API_KEY=', category: 'finance', description: 'Polygon.io official financial market data' },
  { label: 'ConfigCat', name: 'configcat', command: 'npx', args: '-y @configcat/mcp-server', env: 'CONFIGCAT_API_KEY=', category: 'api', description: 'ConfigCat feature flag management' },
  { label: 'Confluent Kafka (Official)', name: 'confluent-official', command: 'npx', args: '-y @confluentinc/mcp-confluent', env: 'CONFLUENT_API_KEY=\nCONFLUENT_API_SECRET=', category: 'api', description: 'Confluent official Kafka messaging' },
  { label: 'Nango', name: 'nango', command: 'npx', args: '-y @nango/mcp-server', env: 'NANGO_SECRET_KEY=', category: 'api', description: 'Nango 500+ API integrations (open source)' },

  // ── 보안 (가이드) ──
  { label: 'Auth0 (Official)', name: 'auth0-official', command: 'npx', args: '-y @auth0/auth0-mcp-server', env: 'AUTH0_DOMAIN=\nAUTH0_CLIENT_ID=\nAUTH0_CLIENT_SECRET=', category: 'security', description: 'Auth0 official authentication/identity management' },
  { label: 'Snyk (Official)', name: 'snyk-official', command: 'npx', args: '-y @snyk/mcp-server', env: 'SNYK_TOKEN=', category: 'security', description: 'Snyk official vulnerability scan' },
  { label: 'GitGuardian', name: 'gitguardian', command: 'npx', args: '-y @gitguardian/mcp-server', env: 'GITGUARDIAN_API_KEY=', category: 'security', description: 'GitGuardian secret detection' },
  { label: 'Semgrep (Official)', name: 'semgrep-mcp-official', command: 'npx', args: '-y @semgrep/mcp-server', env: 'SEMGREP_APP_TOKEN=', category: 'security', description: 'Semgrep official code security analysis' },
  { label: 'BoostSecurity', name: 'boost-security', command: 'npx', args: '-y @boost-community/boost-mcp', category: 'security', description: 'Dependency vulnerability/malware prevention' },
  { label: 'CrowdStrike Falcon', name: 'crowdstrike', command: 'npx', args: '-y @crowdstrike/mcp-server', env: 'CROWDSTRIKE_CLIENT_ID=\nCROWDSTRIKE_CLIENT_SECRET=', category: 'security', description: 'CrowdStrike detection/incidents/threats' },
  { label: 'Burp Suite', name: 'burp-suite', command: 'npx', args: '-y @portswigger/mcp-server', category: 'security', description: 'Burp Suite web security scan' },
  { label: 'Keycloak', name: 'keycloak', command: 'npx', args: '-y @keycloak/mcp-server', env: 'KEYCLOAK_URL=\nKEYCLOAK_REALM=', category: 'security', description: 'Keycloak identity/access management' },

  // ── 검색 엔진 (가이드) ──
  { label: 'Tavily (Official)', name: 'tavily-official', command: 'npx', args: '-y @tavily/mcp-server', env: 'TAVILY_API_KEY=', category: 'search', description: 'Tavily official AI search' },
  { label: 'SerpAPI (Official)', name: 'serpapi-official', command: 'npx', args: '-y @serpapi/mcp-server', env: 'SERPAPI_API_KEY=', category: 'search', description: 'SerpAPI official multi-search engine' },
  { label: 'Apify (Official)', name: 'apify-official', command: 'npx', args: '-y @apify/mcp-server', env: 'APIFY_TOKEN=', category: 'search', description: 'Apify official 6000+ crawlers/search' },
  { label: 'ArXiv Papers', name: 'arxiv-papers', command: 'npx', args: '-y arxiv-mcp-server', category: 'search', description: 'ArXiv academic paper search' },

  // ── 커뮤니케이션 (가이드) ──
  { label: 'Slack (Zencoder)', name: 'slack-mcp', command: 'npx', args: '-y @anthropic/slack-mcp-server', env: 'SLACK_BOT_TOKEN=\nSLACK_TEAM_ID=', category: 'communication', description: 'Slack official messages/channels' },
  { label: 'Mailgun (Official)', name: 'mailgun-mcp', command: 'npx', args: '-y @mailgun/mcp-server', env: 'MAILGUN_API_KEY=\nMAILGUN_DOMAIN=', category: 'communication', description: 'Mailgun official email sending' },
  { label: 'Elastic Email', name: 'elastic-email', command: 'npx', args: '-y @elasticemail/mcp-server', env: 'ELASTIC_EMAIL_API_KEY=', category: 'communication', description: 'Elastic Email email features' },
  { label: 'Infobip', name: 'infobip-mcp', command: 'npx', args: '-y @infobip/mcp-server', env: 'INFOBIP_API_KEY=', category: 'communication', description: 'Infobip SMS/WhatsApp/email' },

  // ── 분석 (가이드) ──
  { label: 'Mixpanel (Official)', name: 'mixpanel-official', command: 'npx', args: '-y @mixpanel/mcp-server', env: 'MIXPANEL_TOKEN=', category: 'analytics', description: 'Mixpanel official product analytics' },
  { label: 'Amplitude (Official)', name: 'amplitude-official', command: 'npx', args: '-y @amplitude/mcp-server', env: 'AMPLITUDE_API_KEY=', category: 'analytics', description: 'Amplitude official analytics platform' },
  { label: 'dbt (Official)', name: 'dbt-official', command: 'npx', args: '-y @dbt-labs/dbt-mcp', env: 'DBT_TOKEN=', category: 'analytics', description: 'dbt official data build/metadata' },
  { label: 'Databricks', name: 'databricks', command: 'npx', args: '-y @databricks/mcp-server', env: 'DATABRICKS_HOST=\nDATABRICKS_TOKEN=', category: 'analytics', description: 'Databricks data/AI platform' },
  { label: 'ThoughtSpot', name: 'thoughtspot', command: 'npx', args: '-y @thoughtspot/mcp-server', env: 'THOUGHTSPOT_URL=\nTHOUGHTSPOT_TOKEN=', category: 'analytics', description: 'ThoughtSpot data analytics' },
  { label: 'DataHub', name: 'datahub', command: 'npx', args: '-y @acryldata/mcp-server-datahub', env: 'DATAHUB_GMS_URL=', category: 'analytics', description: 'DataHub metadata/lineage' },
  { label: 'ECharts MCP', name: 'echarts-mcp', command: 'npx', args: '-y @hustcc/mcp-echarts', category: 'analytics', description: 'ECharts data visualization charts' },

  // ── 개발 도구 (가이드) ──
  { label: 'Postman (Official)', name: 'postman-official', command: 'npx', args: '-y @postmanlabs/postman-mcp-server', env: 'POSTMAN_API_KEY=', category: 'devtools', description: 'Postman official API integration' },
  { label: 'n8n MCP', name: 'n8n-mcp', command: 'npx', args: '-y @gomakers-ai/mcp-n8n', env: 'N8N_API_URL=\nN8N_API_KEY=', category: 'automation', description: 'n8n workflow management (41 tools)' },
  { label: 'Kestra', name: 'kestra', command: 'npx', args: '-y @kestra-io/mcp-server', env: 'KESTRA_URL=\nKESTRA_API_TOKEN=', category: 'automation', description: 'Kestra workflow orchestration' },
  { label: 'Bright Data (Official)', name: 'brightdata-official', command: 'npx', args: '-y @brightdata/mcp', env: 'BRIGHT_DATA_API_KEY=', category: 'devtools', description: 'Bright Data web data collection' },
  { label: 'Composio', name: 'composio', command: 'npx', args: '-y @composio/mcp-server', env: 'COMPOSIO_API_KEY=', category: 'devtools', description: 'Composio 100+ tool integrations' },
  { label: 'Desktop Commander', name: 'desktop-commander-mcp', command: 'npx', args: '-y @wonderwhy-er/desktop-commander', category: 'devtools', description: 'File editing/terminal/SSH local MCP' },
  { label: 'YepCode', name: 'yepcode', command: 'npx', args: '-y @yepcode/mcp-server', env: 'YEPCODE_API_KEY=', category: 'devtools', description: 'YepCode sandbox code execution' },
  { label: 'Storybook (Official)', name: 'storybook-official', command: 'npx', args: '-y @storybook/addon-mcp', category: 'devtools', description: 'Storybook official component stories' },
  { label: 'Next.js DevTools (Official)', name: 'nextjs-devtools', command: 'npx', args: '-y @vercel/next-devtools-mcp', category: 'devtools', description: 'Next.js official runtime diagnostics' },

  // ── DevOps (가이드) ──
  { label: 'CircleCI', name: 'circleci-official', command: 'npx', args: '-y @circleci-public/mcp-server-circleci', env: 'CIRCLECI_TOKEN=', category: 'devops', description: 'CircleCI official build failure fixes' },

  // ── 파일 시스템 (가이드) ──
  { label: 'MarkItDown (Microsoft)', name: 'markitdown-microsoft', command: 'npx', args: '-y @microsoft/markitdown-mcp', category: 'filesystem', description: 'Microsoft file to Markdown conversion' },
  { label: 'Box (Official)', name: 'box-official', command: 'npx', args: '-y @box/mcp-server', env: 'BOX_JWT_CONFIG=', category: 'filesystem', description: 'Box official file management' },

  // ── 미디어 (가이드) ──
  { label: 'MasterGo', name: 'mastergo', command: 'npx', args: '-y @mastergo/mcp-server', env: 'MASTERGO_API_KEY=', category: 'design', description: 'MasterGo design file to DSL' },
  { label: 'Mux Video (Official)', name: 'mux-official', command: 'npx', args: '-y @mux/mcp-server', env: 'MUX_TOKEN_ID=\nMUX_TOKEN_SECRET=', category: 'media', description: 'Mux official video upload/streaming' },
  { label: 'WaveSpeed AI', name: 'wavespeed', command: 'npx', args: '-y @wavespeedai/mcp-server', env: 'WAVESPEED_API_KEY=', category: 'media', description: 'WaveSpeed image/video generation' },

  // ── 문서 / 교육 (가이드) ──
  { label: 'Wolfram Alpha', name: 'wolfram-mcp', command: 'npx', args: '-y mcp-wolframalpha', env: 'WOLFRAM_APP_ID=', category: 'docs', description: 'Wolfram Alpha computational knowledge engine' },
];
