import type { Skill } from './types';

/**
 * 종합 쉘 명령어 갤러리 — 지구상에 존재하는 주요 쉘 명령어 모음
 * 카테고리: file, text, search, system, process, network, disk, compress,
 *          permission, git, docker, k8s, package, ssh, env, date, math,
 *          macos, dev, db, cloud, security, misc
 */
export const SHELL_GALLERY_SKILLS: Skill[] = [

  // ═══════════════════════════════════════
  // ██  파일 & 디렉토리 (File & Directory)
  // ═══════════════════════════════════════
  { id: 'sh-ls', name: 'ls', description: 'List files', emoji: '📂', command: 'ls -la', cliType: 'shell', category: 'system', tags: ['file', 'list'] },
  { id: 'sh-ls-size', name: 'ls (by size)', description: 'Sort by file size', emoji: '📂', command: 'ls -lhS', cliType: 'shell', category: 'system', tags: ['file', 'size'] },
  { id: 'sh-ls-time', name: 'ls (by time)', description: 'Sort by modification time', emoji: '📂', command: 'ls -lt', cliType: 'shell', category: 'system', tags: ['file', 'time'] },
  { id: 'sh-ls-recursive', name: 'ls (recursive)', description: 'List including subdirectories', emoji: '📂', command: 'ls -laR', cliType: 'shell', category: 'system', tags: ['file', 'recursive'] },
  { id: 'sh-ls-tree', name: 'tree', description: 'Directory tree structure', emoji: '🌲', command: 'tree -L 3 -I node_modules', cliType: 'shell', category: 'system', tags: ['tree', 'directory'] },
  { id: 'sh-mkdir', name: 'mkdir', description: 'Create directory (-p recursive)', emoji: '📁', command: 'mkdir -p', cliType: 'shell', category: 'system', tags: ['dir', 'create'] },
  { id: 'sh-cp', name: 'cp', description: 'Copy file/folder', emoji: '📋', command: 'cp -r', cliType: 'shell', category: 'system', tags: ['copy'] },
  { id: 'sh-mv', name: 'mv', description: 'Move or rename file/folder', emoji: '📦', command: 'mv', cliType: 'shell', category: 'system', tags: ['move', 'rename'] },
  { id: 'sh-rm', name: 'rm', description: 'Delete file/folder', emoji: '🗑️', command: 'rm -rf', cliType: 'shell', category: 'system', tags: ['delete'] },
  { id: 'sh-touch', name: 'touch', description: 'Create empty file / update timestamp', emoji: '✋', command: 'touch', cliType: 'shell', category: 'system', tags: ['file', 'create'] },
  { id: 'sh-ln', name: 'ln (symlink)', description: 'Create symbolic link', emoji: '🔗', command: 'ln -s', cliType: 'shell', category: 'system', tags: ['link', 'symlink'] },
  { id: 'sh-readlink', name: 'readlink', description: 'Symbolic link target path', emoji: '🔗', command: 'readlink -f', cliType: 'shell', category: 'system', tags: ['link'] },
  { id: 'sh-stat', name: 'stat', description: 'File details', emoji: '📊', command: 'stat', cliType: 'shell', category: 'system', tags: ['file', 'info'] },
  { id: 'sh-file', name: 'file', description: 'Check file type', emoji: '🔍', command: 'file', cliType: 'shell', category: 'system', tags: ['file', 'type'] },
  { id: 'sh-basename', name: 'basename', description: 'Extract filename from path', emoji: '✂️', command: 'basename', cliType: 'shell', category: 'system', tags: ['path'] },
  { id: 'sh-dirname', name: 'dirname', description: 'Extract directory from path', emoji: '✂️', command: 'dirname', cliType: 'shell', category: 'system', tags: ['path'] },
  { id: 'sh-realpath', name: 'realpath', description: 'Resolve absolute path', emoji: '📍', command: 'realpath', cliType: 'shell', category: 'system', tags: ['path'] },
  { id: 'sh-pwd', name: 'pwd', description: 'Current working directory', emoji: '📍', command: 'pwd', cliType: 'shell', category: 'system', tags: ['directory'] },
  { id: 'sh-cd', name: 'cd', description: 'Change directory', emoji: '🚶', command: 'cd', cliType: 'shell', category: 'system', tags: ['directory'] },
  { id: 'sh-find-name', name: 'find (by name)', description: 'Search by filename', emoji: '🔎', command: 'find . -name "*.ts" -not -path "*/node_modules/*"', cliType: 'shell', category: 'system', tags: ['find', 'search'] },
  { id: 'sh-find-size', name: 'find (by size)', description: 'Search by file size', emoji: '🔎', command: 'find . -size +10M -type f', cliType: 'shell', category: 'system', tags: ['find', 'size'] },
  { id: 'sh-find-mtime', name: 'find (recently modified)', description: 'Files modified within the last N days', emoji: '🔎', command: 'find . -mtime -7 -type f', cliType: 'shell', category: 'system', tags: ['find', 'time'] },
  { id: 'sh-find-empty', name: 'find (empty files)', description: 'Find empty files/directories', emoji: '🔎', command: 'find . -empty', cliType: 'shell', category: 'system', tags: ['find', 'empty'] },
  { id: 'sh-find-exec', name: 'find + exec', description: 'Run command on found files', emoji: '🔎', command: 'find . -name "*.log" -exec rm {} \\;', cliType: 'shell', category: 'system', tags: ['find', 'exec'] },
  { id: 'sh-locate', name: 'locate', description: 'Index-based fast file search', emoji: '⚡', command: 'locate', cliType: 'shell', category: 'system', tags: ['find', 'fast'] },
  { id: 'sh-which', name: 'which', description: 'Find command execution path', emoji: '❓', command: 'which', cliType: 'shell', category: 'system', tags: ['path', 'binary'] },
  { id: 'sh-whereis', name: 'whereis', description: 'Command binary/source/manual location', emoji: '❓', command: 'whereis', cliType: 'shell', category: 'system', tags: ['path'] },
  { id: 'sh-type', name: 'type', description: 'Check command type (alias/builtin/file)', emoji: '❓', command: 'type', cliType: 'shell', category: 'system', tags: ['command'] },

  // ═══════════════════════════════════════
  // ██  텍스트 처리 (Text Processing)
  // ═══════════════════════════════════════
  { id: 'sh-cat', name: 'cat', description: 'Print file contents', emoji: '📄', command: 'cat', cliType: 'shell', category: 'system', tags: ['text', 'read'] },
  { id: 'sh-cat-n', name: 'cat -n', description: 'Print with line numbers', emoji: '📄', command: 'cat -n', cliType: 'shell', category: 'system', tags: ['text', 'line-number'] },
  { id: 'sh-head', name: 'head', description: 'Print start of file', emoji: '⬆️', command: 'head -n 20', cliType: 'shell', category: 'system', tags: ['text'] },
  { id: 'sh-tail', name: 'tail', description: 'Print end of file', emoji: '⬇️', command: 'tail -n 20', cliType: 'shell', category: 'system', tags: ['text'] },
  { id: 'sh-tail-f', name: 'tail -f', description: 'Real-time log monitoring', emoji: '👁️', command: 'tail -f', cliType: 'shell', category: 'system', tags: ['log', 'monitor'] },
  { id: 'sh-less', name: 'less', description: 'Read file page by page', emoji: '📖', command: 'less', cliType: 'shell', category: 'system', tags: ['text', 'pager'] },
  { id: 'sh-more', name: 'more', description: 'View file page by page', emoji: '📖', command: 'more', cliType: 'shell', category: 'system', tags: ['text', 'pager'] },
  { id: 'sh-wc', name: 'wc', description: 'Count lines/words/bytes', emoji: '🔢', command: 'wc -l', cliType: 'shell', category: 'system', tags: ['text', 'count'] },
  { id: 'sh-wc-words', name: 'wc -w', description: 'Count words', emoji: '🔢', command: 'wc -w', cliType: 'shell', category: 'system', tags: ['text', 'count'] },
  { id: 'sh-sort', name: 'sort', description: 'Sort lines', emoji: '🔤', command: 'sort', cliType: 'shell', category: 'system', tags: ['text', 'sort'] },
  { id: 'sh-sort-nr', name: 'sort -nr', description: 'Sort numerically in reverse', emoji: '🔤', command: 'sort -nr', cliType: 'shell', category: 'system', tags: ['text', 'sort'] },
  { id: 'sh-sort-unique', name: 'sort -u', description: 'Sort + deduplicate', emoji: '🔤', command: 'sort -u', cliType: 'shell', category: 'system', tags: ['text', 'sort', 'unique'] },
  { id: 'sh-uniq', name: 'uniq', description: 'Remove consecutive duplicate lines', emoji: '🔗', command: 'sort | uniq', cliType: 'shell', category: 'system', tags: ['text', 'unique'] },
  { id: 'sh-uniq-c', name: 'uniq -c', description: 'Count duplicate occurrences', emoji: '🔗', command: 'sort | uniq -c | sort -rn', cliType: 'shell', category: 'system', tags: ['text', 'count'] },
  { id: 'sh-cut', name: 'cut', description: 'Extract fields/columns', emoji: '✂️', command: 'cut -d"," -f1,3', cliType: 'shell', category: 'system', tags: ['text', 'column'] },
  { id: 'sh-tr', name: 'tr', description: 'Replace/delete characters', emoji: '🔄', command: 'tr "[:lower:]" "[:upper:]"', cliType: 'shell', category: 'system', tags: ['text', 'replace'] },
  { id: 'sh-tr-delete', name: 'tr -d', description: 'Delete specific characters', emoji: '🔄', command: 'tr -d "\\n"', cliType: 'shell', category: 'system', tags: ['text', 'delete'] },
  { id: 'sh-rev', name: 'rev', description: 'Reverse a string', emoji: '🔄', command: 'rev', cliType: 'shell', category: 'system', tags: ['text', 'reverse'] },
  { id: 'sh-tac', name: 'tac', description: 'Reverse line order', emoji: '🔄', command: 'tac', cliType: 'shell', category: 'system', tags: ['text', 'reverse'] },
  { id: 'sh-paste', name: 'paste', description: 'Merge file columns', emoji: '📎', command: 'paste -d"\\t"', cliType: 'shell', category: 'system', tags: ['text', 'merge'] },
  { id: 'sh-column', name: 'column', description: 'Print aligned as a table', emoji: '📊', command: 'column -t -s","', cliType: 'shell', category: 'system', tags: ['text', 'table'] },
  { id: 'sh-diff', name: 'diff', description: 'Compare files', emoji: '🔀', command: 'diff -u', cliType: 'shell', category: 'system', tags: ['text', 'compare'] },
  { id: 'sh-comm', name: 'comm', description: 'Compare sorted files (common/diff)', emoji: '🔀', command: 'comm', cliType: 'shell', category: 'system', tags: ['text', 'compare'] },
  { id: 'sh-tee', name: 'tee', description: 'Output to screen and file at once', emoji: '🔀', command: 'tee output.log', cliType: 'shell', category: 'system', tags: ['text', 'redirect'] },
  { id: 'sh-xargs', name: 'xargs', description: 'Pass pipe output as arguments', emoji: '⚙️', command: 'xargs', cliType: 'shell', category: 'system', tags: ['pipe', 'args'] },
  { id: 'sh-xargs-parallel', name: 'xargs -P', description: 'Parallel execution', emoji: '⚙️', command: 'xargs -P4 -I{} sh -c \'echo {}\'', cliType: 'shell', category: 'system', tags: ['parallel'] },

  // ═══════════════════════════════════════
  // ██  grep / sed / awk
  // ═══════════════════════════════════════
  { id: 'sh-grep', name: 'grep', description: 'Search for a pattern', emoji: '🔍', command: 'grep -rn "pattern" .', cliType: 'shell', category: 'system', tags: ['search', 'grep'] },
  { id: 'sh-grep-i', name: 'grep -i', description: 'Case-insensitive search', emoji: '🔍', command: 'grep -rni "pattern" .', cliType: 'shell', category: 'system', tags: ['search'] },
  { id: 'sh-grep-v', name: 'grep -v', description: 'Exclude pattern (inverse match)', emoji: '🔍', command: 'grep -v "pattern"', cliType: 'shell', category: 'system', tags: ['search', 'exclude'] },
  { id: 'sh-grep-c', name: 'grep -c', description: 'Count match occurrences', emoji: '🔍', command: 'grep -c "pattern"', cliType: 'shell', category: 'system', tags: ['search', 'count'] },
  { id: 'sh-grep-l', name: 'grep -l', description: 'Print only matched filenames', emoji: '🔍', command: 'grep -rl "pattern" .', cliType: 'shell', category: 'system', tags: ['search', 'files'] },
  { id: 'sh-grep-context', name: 'grep -C', description: 'Include N lines around match', emoji: '🔍', command: 'grep -rn -C3 "pattern" .', cliType: 'shell', category: 'system', tags: ['search', 'context'] },
  { id: 'sh-grep-regex', name: 'grep -E', description: 'Extended regex search', emoji: '🔍', command: 'grep -rEn "(TODO|FIXME|HACK)" .', cliType: 'shell', category: 'system', tags: ['search', 'regex'] },
  { id: 'sh-rg', name: 'rg (ripgrep)', description: 'Ultra-fast search (ripgrep)', emoji: '⚡', command: 'rg "pattern" --type ts', cliType: 'shell', category: 'system', tags: ['search', 'ripgrep'] },
  { id: 'sh-ag', name: 'ag (silver searcher)', description: 'Fast code search', emoji: '⚡', command: 'ag "pattern"', cliType: 'shell', category: 'system', tags: ['search'] },
  { id: 'sh-sed', name: 'sed (replace)', description: 'Replace text', emoji: '✏️', command: 'sed -i "" "s/old/new/g"', cliType: 'shell', category: 'system', tags: ['text', 'replace', 'sed'] },
  { id: 'sh-sed-delete', name: 'sed (delete line)', description: 'Delete specific lines', emoji: '✏️', command: 'sed -i "" "/pattern/d"', cliType: 'shell', category: 'system', tags: ['text', 'delete', 'sed'] },
  { id: 'sh-sed-insert', name: 'sed (insert line)', description: 'Insert before a specific line', emoji: '✏️', command: 'sed -i "" "/pattern/i\\new line"', cliType: 'shell', category: 'system', tags: ['text', 'insert', 'sed'] },
  { id: 'sh-sed-range', name: 'sed (print range)', description: 'Print line range N-M', emoji: '✏️', command: 'sed -n "10,20p"', cliType: 'shell', category: 'system', tags: ['text', 'range', 'sed'] },
  { id: 'sh-awk', name: 'awk (extract fields)', description: 'Extract specific columns', emoji: '🧮', command: "awk '{print $1, $3}'", cliType: 'shell', category: 'system', tags: ['text', 'awk', 'column'] },
  { id: 'sh-awk-sum', name: 'awk (sum)', description: 'Sum a numeric column', emoji: '🧮', command: "awk '{sum+=$1} END{print sum}'", cliType: 'shell', category: 'system', tags: ['text', 'awk', 'sum'] },
  { id: 'sh-awk-filter', name: 'awk (conditional filter)', description: 'Print only lines matching a condition', emoji: '🧮', command: "awk '$3 > 100 {print $0}'", cliType: 'shell', category: 'system', tags: ['text', 'awk', 'filter'] },
  { id: 'sh-awk-csv', name: 'awk (CSV processing)', description: 'Extract CSV fields', emoji: '🧮', command: "awk -F',' '{print $1,$2}'", cliType: 'shell', category: 'system', tags: ['text', 'awk', 'csv'] },
  { id: 'sh-awk-count', name: 'awk (frequency count)', description: 'Count frequency by value', emoji: '🧮', command: "awk '{count[$1]++} END{for(k in count) print k, count[k]}'", cliType: 'shell', category: 'system', tags: ['text', 'awk', 'count'] },

  // ═══════════════════════════════════════
  // ██  시스템 정보 (System Info)
  // ═══════════════════════════════════════
  { id: 'sh-uname', name: 'uname -a', description: 'Full system info', emoji: '🖥️', command: 'uname -a', cliType: 'shell', category: 'system', tags: ['system', 'info'] },
  { id: 'sh-hostname', name: 'hostname', description: 'Hostname', emoji: '🖥️', command: 'hostname', cliType: 'shell', category: 'system', tags: ['system'] },
  { id: 'sh-uptime', name: 'uptime', description: 'System uptime & load', emoji: '⏱️', command: 'uptime', cliType: 'shell', category: 'system', tags: ['system', 'uptime'] },
  { id: 'sh-whoami', name: 'whoami', description: 'Current user', emoji: '👤', command: 'whoami', cliType: 'shell', category: 'system', tags: ['user'] },
  { id: 'sh-id', name: 'id', description: 'User ID and group info', emoji: '👤', command: 'id', cliType: 'shell', category: 'system', tags: ['user', 'group'] },
  { id: 'sh-env', name: 'env', description: 'List all environment variables', emoji: '🌍', command: 'env', cliType: 'shell', category: 'system', tags: ['env'] },
  { id: 'sh-printenv', name: 'printenv', description: 'Print a specific environment variable', emoji: '🌍', command: 'printenv PATH', cliType: 'shell', category: 'system', tags: ['env'] },
  { id: 'sh-export', name: 'export', description: 'Set environment variable', emoji: '🌍', command: 'export KEY=value', cliType: 'shell', category: 'system', tags: ['env'] },
  { id: 'sh-echo', name: 'echo', description: 'Print text', emoji: '💬', command: 'echo', cliType: 'shell', category: 'system', tags: ['output'] },
  { id: 'sh-printf', name: 'printf', description: 'Formatted output', emoji: '💬', command: 'printf "%s\\n"', cliType: 'shell', category: 'system', tags: ['output', 'format'] },
  { id: 'sh-alias', name: 'alias', description: 'List/set command aliases', emoji: '🏷️', command: 'alias', cliType: 'shell', category: 'system', tags: ['alias'] },
  { id: 'sh-history', name: 'history', description: 'Command history', emoji: '📜', command: 'history | tail -30', cliType: 'shell', category: 'system', tags: ['history'] },
  { id: 'sh-man', name: 'man', description: 'View manual page', emoji: '📘', command: 'man', cliType: 'shell', category: 'system', tags: ['help', 'manual'] },
  { id: 'sh-tldr', name: 'tldr', description: 'Concise command help', emoji: '📘', command: 'tldr', cliType: 'shell', category: 'system', tags: ['help'] },

  // ═══════════════════════════════════════
  // ██  프로세스 관리 (Process Management)
  // ═══════════════════════════════════════
  { id: 'sh-ps', name: 'ps aux', description: 'List running processes', emoji: '⚙️', command: 'ps aux', cliType: 'shell', category: 'system', tags: ['process'] },
  { id: 'sh-ps-tree', name: 'ps tree', description: 'View process tree', emoji: '🌲', command: 'ps auxf', cliType: 'shell', category: 'system', tags: ['process', 'tree'] },
  { id: 'sh-top', name: 'top', description: 'Real-time process monitor', emoji: '📈', command: 'top', cliType: 'shell', category: 'system', tags: ['process', 'monitor'] },
  { id: 'sh-htop', name: 'htop', description: 'Enhanced process monitor', emoji: '📈', command: 'htop', cliType: 'shell', category: 'system', tags: ['process', 'monitor'] },
  { id: 'sh-btop', name: 'btop', description: 'Resource monitor (btop++)', emoji: '📈', command: 'btop', cliType: 'shell', category: 'system', tags: ['process', 'monitor'] },
  { id: 'sh-kill', name: 'kill', description: 'Kill process (PID)', emoji: '💀', command: 'kill -9', cliType: 'shell', category: 'system', tags: ['process', 'kill'] },
  { id: 'sh-killall', name: 'killall', description: 'Kill process by name', emoji: '💀', command: 'killall', cliType: 'shell', category: 'system', tags: ['process', 'kill'] },
  { id: 'sh-pkill', name: 'pkill', description: 'Kill process by pattern', emoji: '💀', command: 'pkill -f', cliType: 'shell', category: 'system', tags: ['process', 'kill'] },
  { id: 'sh-pgrep', name: 'pgrep', description: 'Find PID by name', emoji: '🔍', command: 'pgrep -la', cliType: 'shell', category: 'system', tags: ['process', 'find'] },
  { id: 'sh-lsof', name: 'lsof', description: 'List open files/ports', emoji: '📋', command: 'lsof -i', cliType: 'shell', category: 'system', tags: ['process', 'port'] },
  { id: 'sh-lsof-port', name: 'lsof (port)', description: 'Process using a specific port', emoji: '🔌', command: 'lsof -i :3000', cliType: 'shell', category: 'network', tags: ['port', 'process'] },
  { id: 'sh-nohup', name: 'nohup', description: 'Keep running after logout', emoji: '🔄', command: 'nohup command &', cliType: 'shell', category: 'system', tags: ['background'] },
  { id: 'sh-bg', name: 'bg / fg', description: 'Switch background/foreground', emoji: '🔄', command: 'bg %1', cliType: 'shell', category: 'system', tags: ['background'] },
  { id: 'sh-jobs', name: 'jobs', description: 'List background jobs', emoji: '📋', command: 'jobs -l', cliType: 'shell', category: 'system', tags: ['background', 'jobs'] },
  { id: 'sh-wait', name: 'wait', description: 'Wait for background jobs', emoji: '⏳', command: 'wait', cliType: 'shell', category: 'system', tags: ['background'] },
  { id: 'sh-nice', name: 'nice', description: 'Run with set priority', emoji: '⚖️', command: 'nice -n 10', cliType: 'shell', category: 'system', tags: ['priority'] },
  { id: 'sh-renice', name: 'renice', description: 'Change priority of a running process', emoji: '⚖️', command: 'renice -n 5 -p', cliType: 'shell', category: 'system', tags: ['priority'] },
  { id: 'sh-timeout', name: 'timeout', description: 'Run command with a time limit', emoji: '⏰', command: 'timeout 10s', cliType: 'shell', category: 'system', tags: ['timeout'] },
  { id: 'sh-watch', name: 'watch', description: 'Monitor a repeating command', emoji: '👁️', command: 'watch -n 2', cliType: 'shell', category: 'system', tags: ['monitor', 'repeat'] },
  { id: 'sh-cron', name: 'crontab', description: 'Edit cron schedule', emoji: '📅', command: 'crontab -l', cliType: 'shell', category: 'system', tags: ['cron', 'schedule'] },

  // ═══════════════════════════════════════
  // ██  네트워크 (Network)
  // ═══════════════════════════════════════
  { id: 'sh-curl', name: 'curl', description: 'HTTP request', emoji: '🌐', command: 'curl -s', cliType: 'shell', category: 'network', tags: ['http', 'curl'] },
  { id: 'sh-curl-post', name: 'curl POST', description: 'POST request with JSON', emoji: '🌐', command: 'curl -X POST -H "Content-Type: application/json" -d \'{"key":"value"}\'', cliType: 'shell', category: 'network', tags: ['http', 'post'] },
  { id: 'sh-curl-header', name: 'curl (with headers)', description: 'Check response headers', emoji: '🌐', command: 'curl -I', cliType: 'shell', category: 'network', tags: ['http', 'header'] },
  { id: 'sh-curl-dl', name: 'curl (download)', description: 'Download file', emoji: '⬇️', command: 'curl -O -L', cliType: 'shell', category: 'network', tags: ['download'] },
  { id: 'sh-wget', name: 'wget', description: 'Download file', emoji: '⬇️', command: 'wget', cliType: 'shell', category: 'network', tags: ['download'] },
  { id: 'sh-ping', name: 'ping', description: 'Check network connectivity', emoji: '🏓', command: 'ping -c 4', cliType: 'shell', category: 'network', tags: ['ping'] },
  { id: 'sh-traceroute', name: 'traceroute', description: 'Trace network route', emoji: '🗺️', command: 'traceroute', cliType: 'shell', category: 'network', tags: ['trace', 'route'] },
  { id: 'sh-nslookup', name: 'nslookup', description: 'DNS lookup', emoji: '🌐', command: 'nslookup', cliType: 'shell', category: 'network', tags: ['dns'] },
  { id: 'sh-dig', name: 'dig', description: 'Detailed DNS lookup', emoji: '🌐', command: 'dig', cliType: 'shell', category: 'network', tags: ['dns'] },
  { id: 'sh-host', name: 'host', description: 'DNS host lookup', emoji: '🌐', command: 'host', cliType: 'shell', category: 'network', tags: ['dns'] },
  { id: 'sh-ifconfig', name: 'ifconfig', description: 'Network interface info', emoji: '🔌', command: 'ifconfig', cliType: 'shell', category: 'network', tags: ['ip', 'interface'] },
  { id: 'sh-ip', name: 'ip addr', description: 'Check IP address (Linux)', emoji: '🔌', command: 'ip addr show', cliType: 'shell', category: 'network', tags: ['ip'] },
  { id: 'sh-netstat', name: 'netstat', description: 'Network connection status', emoji: '📊', command: 'netstat -tuln', cliType: 'shell', category: 'network', tags: ['port', 'connection'] },
  { id: 'sh-ss', name: 'ss', description: 'Socket statistics (netstat alternative)', emoji: '📊', command: 'ss -tuln', cliType: 'shell', category: 'network', tags: ['port', 'socket'] },
  { id: 'sh-nc', name: 'nc (netcat)', description: 'Test port connection', emoji: '🔌', command: 'nc -zv', cliType: 'shell', category: 'network', tags: ['port', 'test'] },
  { id: 'sh-nmap', name: 'nmap', description: 'Port scan', emoji: '🗺️', command: 'nmap -sT', cliType: 'shell', category: 'network', tags: ['scan', 'port'] },
  { id: 'sh-arp', name: 'arp', description: 'View ARP table', emoji: '📋', command: 'arp -a', cliType: 'shell', category: 'network', tags: ['arp'] },
  { id: 'sh-route', name: 'route', description: 'Routing table', emoji: '🗺️', command: 'route -n', cliType: 'shell', category: 'network', tags: ['route'] },
  { id: 'sh-iptables', name: 'iptables', description: 'Firewall rules (Linux)', emoji: '🛡️', command: 'sudo iptables -L -n', cliType: 'shell', category: 'network', tags: ['firewall'] },
  { id: 'sh-tcpdump', name: 'tcpdump', description: 'Capture network packets', emoji: '📡', command: 'sudo tcpdump -i any -n', cliType: 'shell', category: 'network', tags: ['packet', 'capture'] },
  { id: 'sh-myip', name: 'Check external IP', description: 'Check public IP address', emoji: '🌍', command: 'curl -s ifconfig.me', cliType: 'shell', category: 'network', tags: ['ip', 'public'] },
  { id: 'sh-speedtest', name: 'speedtest', description: 'Measure internet speed', emoji: '🚀', command: 'speedtest-cli', cliType: 'shell', category: 'network', tags: ['speed'] },

  // ═══════════════════════════════════════
  // ██  디스크 & 스토리지 (Disk & Storage)
  // ═══════════════════════════════════════
  { id: 'sh-df', name: 'df -h', description: 'Disk usage', emoji: '💾', command: 'df -h', cliType: 'shell', category: 'system', tags: ['disk', 'usage'] },
  { id: 'sh-du', name: 'du (directory size)', description: 'Size per directory', emoji: '💾', command: 'du -sh *', cliType: 'shell', category: 'system', tags: ['disk', 'size'] },
  { id: 'sh-du-top', name: 'du (top 20)', description: 'Top 20 largest directories', emoji: '💾', command: 'du -sh * | sort -rh | head -20', cliType: 'shell', category: 'system', tags: ['disk', 'top'] },
  { id: 'sh-ncdu', name: 'ncdu', description: 'Interactive disk usage', emoji: '💾', command: 'ncdu', cliType: 'shell', category: 'system', tags: ['disk', 'interactive'] },
  { id: 'sh-mount', name: 'mount', description: 'List mounted filesystems', emoji: '📀', command: 'mount | column -t', cliType: 'shell', category: 'system', tags: ['mount'] },
  { id: 'sh-fdisk', name: 'fdisk', description: 'Disk partition info', emoji: '📀', command: 'sudo fdisk -l', cliType: 'shell', category: 'system', tags: ['disk', 'partition'] },
  { id: 'sh-free', name: 'free -h', description: 'Memory usage (Linux)', emoji: '🧠', command: 'free -h', cliType: 'shell', category: 'system', tags: ['memory'] },
  { id: 'sh-vm-stat', name: 'vm_stat', description: 'Memory statistics (macOS)', emoji: '🧠', command: 'vm_stat', cliType: 'shell', category: 'system', tags: ['memory', 'macos'] },
  { id: 'sh-iostat', name: 'iostat', description: 'I/O statistics', emoji: '📊', command: 'iostat', cliType: 'shell', category: 'system', tags: ['io', 'stats'] },

  // ═══════════════════════════════════════
  // ██  압축 & 아카이브 (Compress)
  // ═══════════════════════════════════════
  { id: 'sh-tar-create', name: 'tar (compress)', description: 'Create tar.gz archive', emoji: '📦', command: 'tar -czf archive.tar.gz', cliType: 'shell', category: 'system', tags: ['compress', 'tar'] },
  { id: 'sh-tar-extract', name: 'tar (extract)', description: 'Extract tar.gz archive', emoji: '📦', command: 'tar -xzf', cliType: 'shell', category: 'system', tags: ['extract', 'tar'] },
  { id: 'sh-tar-list', name: 'tar (list)', description: 'List archive contents', emoji: '📦', command: 'tar -tzf', cliType: 'shell', category: 'system', tags: ['list', 'tar'] },
  { id: 'sh-zip', name: 'zip', description: 'ZIP compress', emoji: '🗜️', command: 'zip -r archive.zip', cliType: 'shell', category: 'system', tags: ['compress', 'zip'] },
  { id: 'sh-unzip', name: 'unzip', description: 'ZIP extract', emoji: '🗜️', command: 'unzip', cliType: 'shell', category: 'system', tags: ['extract', 'zip'] },
  { id: 'sh-gzip', name: 'gzip', description: 'gzip compress', emoji: '🗜️', command: 'gzip', cliType: 'shell', category: 'system', tags: ['compress'] },
  { id: 'sh-gunzip', name: 'gunzip', description: 'gzip extract', emoji: '🗜️', command: 'gunzip', cliType: 'shell', category: 'system', tags: ['extract'] },
  { id: 'sh-bzip2', name: 'bzip2', description: 'bzip2 compress', emoji: '🗜️', command: 'bzip2', cliType: 'shell', category: 'system', tags: ['compress'] },
  { id: 'sh-xz', name: 'xz', description: 'xz compression (high ratio)', emoji: '🗜️', command: 'xz', cliType: 'shell', category: 'system', tags: ['compress'] },
  { id: 'sh-7z', name: '7z', description: '7-Zip compress/extract', emoji: '🗜️', command: '7z a archive.7z', cliType: 'shell', category: 'system', tags: ['compress', '7zip'] },

  // ═══════════════════════════════════════
  // ██  권한 & 사용자 (Permissions)
  // ═══════════════════════════════════════
  { id: 'sh-chmod', name: 'chmod', description: 'Change file permissions', emoji: '🔐', command: 'chmod 755', cliType: 'shell', category: 'system', tags: ['permission'] },
  { id: 'sh-chmod-r', name: 'chmod -R', description: 'Recursive permission change', emoji: '🔐', command: 'chmod -R 644', cliType: 'shell', category: 'system', tags: ['permission'] },
  { id: 'sh-chown', name: 'chown', description: 'Change file owner', emoji: '👤', command: 'chown user:group', cliType: 'shell', category: 'system', tags: ['owner'] },
  { id: 'sh-chgrp', name: 'chgrp', description: 'Change file group', emoji: '👥', command: 'chgrp', cliType: 'shell', category: 'system', tags: ['group'] },
  { id: 'sh-sudo', name: 'sudo', description: 'Run with admin privileges', emoji: '🔑', command: 'sudo', cliType: 'shell', category: 'system', tags: ['root', 'admin'] },
  { id: 'sh-su', name: 'su', description: 'Switch user', emoji: '👤', command: 'su -', cliType: 'shell', category: 'system', tags: ['user', 'switch'] },
  { id: 'sh-passwd', name: 'passwd', description: 'Change password', emoji: '🔑', command: 'passwd', cliType: 'shell', category: 'system', tags: ['password'] },
  { id: 'sh-groups', name: 'groups', description: 'Check user groups', emoji: '👥', command: 'groups', cliType: 'shell', category: 'system', tags: ['group'] },
  { id: 'sh-umask', name: 'umask', description: 'Default file permission mask', emoji: '🎭', command: 'umask', cliType: 'shell', category: 'system', tags: ['permission', 'mask'] },

  // ═══════════════════════════════════════
  // ██  SSH & 원격 (SSH & Remote)
  // ═══════════════════════════════════════
  { id: 'sh-ssh', name: 'ssh', description: 'Connect to remote server', emoji: '🔒', command: 'ssh user@host', cliType: 'shell', category: 'network', tags: ['ssh', 'remote'] },
  { id: 'sh-ssh-key', name: 'ssh-keygen', description: 'Generate SSH key', emoji: '🔑', command: 'ssh-keygen -t ed25519 -C "email@example.com"', cliType: 'shell', category: 'network', tags: ['ssh', 'key'] },
  { id: 'sh-ssh-copy', name: 'ssh-copy-id', description: 'Copy SSH public key to remote', emoji: '🔑', command: 'ssh-copy-id user@host', cliType: 'shell', category: 'network', tags: ['ssh', 'key'] },
  { id: 'sh-scp', name: 'scp', description: 'SSH file transfer', emoji: '📤', command: 'scp file user@host:path', cliType: 'shell', category: 'network', tags: ['ssh', 'copy'] },
  { id: 'sh-rsync', name: 'rsync', description: 'Incremental sync', emoji: '🔄', command: 'rsync -avz --progress', cliType: 'shell', category: 'network', tags: ['sync', 'backup'] },
  { id: 'sh-sftp', name: 'sftp', description: 'SSH file transfer protocol', emoji: '📤', command: 'sftp user@host', cliType: 'shell', category: 'network', tags: ['ssh', 'file'] },
  { id: 'sh-ssh-tunnel', name: 'ssh tunnel', description: 'SSH port forwarding', emoji: '🔒', command: 'ssh -L 8080:localhost:80 user@host', cliType: 'shell', category: 'network', tags: ['ssh', 'tunnel'] },

  // ═══════════════════════════════════════
  // ██  Git
  // ═══════════════════════════════════════
  { id: 'sh-git-status', name: 'git status', description: 'Check Git status', emoji: '📊', command: 'git status', cliType: 'shell', category: 'git', tags: ['git'] },
  { id: 'sh-git-log', name: 'git log', description: 'Commit log (graph)', emoji: '🌳', command: 'git log --oneline --graph -20', cliType: 'shell', category: 'git', tags: ['git', 'log'] },
  { id: 'sh-git-log-all', name: 'git log (all branches)', description: 'Log of all branches', emoji: '🌳', command: 'git log --oneline --graph --all -30', cliType: 'shell', category: 'git', tags: ['git', 'log'] },
  { id: 'sh-git-diff', name: 'git diff', description: 'Compare changes', emoji: '🔀', command: 'git diff', cliType: 'shell', category: 'git', tags: ['git', 'diff'] },
  { id: 'sh-git-diff-staged', name: 'git diff --staged', description: 'Staged changes', emoji: '🔀', command: 'git diff --staged', cliType: 'shell', category: 'git', tags: ['git', 'diff'] },
  { id: 'sh-git-add', name: 'git add', description: 'Stage changes', emoji: '➕', command: 'git add -p', cliType: 'shell', category: 'git', tags: ['git', 'stage'] },
  { id: 'sh-git-commit', name: 'git commit', description: 'Commit', emoji: '💾', command: 'git commit -m ""', cliType: 'shell', category: 'git', tags: ['git', 'commit'] },
  { id: 'sh-git-push', name: 'git push', description: 'Push to remote', emoji: '⬆️', command: 'git push', cliType: 'shell', category: 'git', tags: ['git', 'push'] },
  { id: 'sh-git-pull', name: 'git pull', description: 'Pull from remote', emoji: '⬇️', command: 'git pull --rebase', cliType: 'shell', category: 'git', tags: ['git', 'pull'] },
  { id: 'sh-git-branch', name: 'git branch', description: 'List/create branches', emoji: '🌿', command: 'git branch -a', cliType: 'shell', category: 'git', tags: ['git', 'branch'] },
  { id: 'sh-git-checkout', name: 'git switch', description: 'Switch branches', emoji: '🔀', command: 'git switch', cliType: 'shell', category: 'git', tags: ['git', 'branch'] },
  { id: 'sh-git-merge', name: 'git merge', description: 'Merge branches', emoji: '🔀', command: 'git merge', cliType: 'shell', category: 'git', tags: ['git', 'merge'] },
  { id: 'sh-git-rebase', name: 'git rebase', description: 'Rebase', emoji: '🔀', command: 'git rebase', cliType: 'shell', category: 'git', tags: ['git', 'rebase'] },
  { id: 'sh-git-stash', name: 'git stash', description: 'Stash changes', emoji: '📋', command: 'git stash', cliType: 'shell', category: 'git', tags: ['git', 'stash'] },
  { id: 'sh-git-stash-pop', name: 'git stash pop', description: 'Restore stash', emoji: '📋', command: 'git stash pop', cliType: 'shell', category: 'git', tags: ['git', 'stash'] },
  { id: 'sh-git-cherry-pick', name: 'git cherry-pick', description: 'Pick a specific commit', emoji: '🍒', command: 'git cherry-pick', cliType: 'shell', category: 'git', tags: ['git'] },
  { id: 'sh-git-reset', name: 'git reset', description: 'Undo commit/stage', emoji: '⏪', command: 'git reset --soft HEAD~1', cliType: 'shell', category: 'git', tags: ['git', 'reset'] },
  { id: 'sh-git-clean', name: 'git clean', description: 'Delete untracked files', emoji: '🧹', command: 'git clean -fd --dry-run', cliType: 'shell', category: 'git', tags: ['git', 'clean'] },
  { id: 'sh-git-tag', name: 'git tag', description: 'List/create tags', emoji: '🏷️', command: 'git tag', cliType: 'shell', category: 'git', tags: ['git', 'tag'] },
  { id: 'sh-git-remote', name: 'git remote', description: 'List remote repositories', emoji: '🌐', command: 'git remote -v', cliType: 'shell', category: 'git', tags: ['git', 'remote'] },
  { id: 'sh-git-blame', name: 'git blame', description: 'Per-line commit history', emoji: '👆', command: 'git blame', cliType: 'shell', category: 'git', tags: ['git', 'blame'] },
  { id: 'sh-git-bisect', name: 'git bisect', description: 'Find buggy commit by binary search', emoji: '🔎', command: 'git bisect start', cliType: 'shell', category: 'git', tags: ['git', 'debug'] },
  { id: 'sh-git-reflog', name: 'git reflog', description: 'HEAD movement history', emoji: '📜', command: 'git reflog -20', cliType: 'shell', category: 'git', tags: ['git', 'history'] },
  { id: 'sh-git-shortlog', name: 'git shortlog', description: 'Commit summary by contributor', emoji: '📊', command: 'git shortlog -sn --all', cliType: 'shell', category: 'git', tags: ['git', 'stats'] },
  { id: 'sh-git-worktree', name: 'git worktree', description: 'Create separate working directory', emoji: '🌲', command: 'git worktree list', cliType: 'shell', category: 'git', tags: ['git', 'worktree'] },

  // ═══════════════════════════════════════
  // ██  Docker
  // ═══════════════════════════════════════
  { id: 'sh-docker-ps', name: 'docker ps', description: 'Running containers', emoji: '🐳', command: 'docker ps', cliType: 'shell', category: 'docker', tags: ['docker'] },
  { id: 'sh-docker-ps-all', name: 'docker ps -a', description: 'All containers (including stopped)', emoji: '🐳', command: 'docker ps -a', cliType: 'shell', category: 'docker', tags: ['docker'] },
  { id: 'sh-docker-images', name: 'docker images', description: 'List local images', emoji: '🐳', command: 'docker images', cliType: 'shell', category: 'docker', tags: ['docker', 'image'] },
  { id: 'sh-docker-run', name: 'docker run', description: 'Run container', emoji: '🐳', command: 'docker run -it --rm', cliType: 'shell', category: 'docker', tags: ['docker', 'run'] },
  { id: 'sh-docker-exec', name: 'docker exec', description: 'Run command inside container', emoji: '🐳', command: 'docker exec -it', cliType: 'shell', category: 'docker', tags: ['docker', 'exec'] },
  { id: 'sh-docker-logs', name: 'docker logs', description: 'Container logs', emoji: '🐳', command: 'docker logs -f', cliType: 'shell', category: 'docker', tags: ['docker', 'logs'] },
  { id: 'sh-docker-build', name: 'docker build', description: 'Build image', emoji: '🐳', command: 'docker build -t myapp .', cliType: 'shell', category: 'docker', tags: ['docker', 'build'] },
  { id: 'sh-docker-stop', name: 'docker stop', description: 'Stop container', emoji: '🐳', command: 'docker stop', cliType: 'shell', category: 'docker', tags: ['docker', 'stop'] },
  { id: 'sh-docker-rm', name: 'docker rm', description: 'Delete container', emoji: '🐳', command: 'docker rm', cliType: 'shell', category: 'docker', tags: ['docker', 'remove'] },
  { id: 'sh-docker-rmi', name: 'docker rmi', description: 'Delete image', emoji: '🐳', command: 'docker rmi', cliType: 'shell', category: 'docker', tags: ['docker', 'remove'] },
  { id: 'sh-docker-compose', name: 'docker compose up', description: 'Start Compose services', emoji: '🐳', command: 'docker compose up -d', cliType: 'shell', category: 'docker', tags: ['docker', 'compose'] },
  { id: 'sh-docker-compose-down', name: 'docker compose down', description: 'Stop Compose services', emoji: '🐳', command: 'docker compose down', cliType: 'shell', category: 'docker', tags: ['docker', 'compose'] },
  { id: 'sh-docker-compose-logs', name: 'docker compose logs', description: 'Compose logs', emoji: '🐳', command: 'docker compose logs -f', cliType: 'shell', category: 'docker', tags: ['docker', 'compose', 'logs'] },
  { id: 'sh-docker-prune', name: 'docker system prune', description: 'Clean up unused resources', emoji: '🧹', command: 'docker system prune -af', cliType: 'shell', category: 'docker', tags: ['docker', 'clean'] },
  { id: 'sh-docker-stats', name: 'docker stats', description: 'Monitor container resources', emoji: '📊', command: 'docker stats', cliType: 'shell', category: 'docker', tags: ['docker', 'monitor'] },
  { id: 'sh-docker-inspect', name: 'docker inspect', description: 'Container/image details', emoji: '🔍', command: 'docker inspect', cliType: 'shell', category: 'docker', tags: ['docker', 'inspect'] },
  { id: 'sh-docker-network', name: 'docker network ls', description: 'List networks', emoji: '🐳', command: 'docker network ls', cliType: 'shell', category: 'docker', tags: ['docker', 'network'] },
  { id: 'sh-docker-volume', name: 'docker volume ls', description: 'List volumes', emoji: '🐳', command: 'docker volume ls', cliType: 'shell', category: 'docker', tags: ['docker', 'volume'] },

  // ═══════════════════════════════════════
  // ██  Kubernetes (k8s)
  // ═══════════════════════════════════════
  { id: 'sh-kubectl-get', name: 'kubectl get pods', description: 'List pods', emoji: '☸️', command: 'kubectl get pods -A', cliType: 'shell', category: 'k8s', tags: ['k8s', 'pods'] },
  { id: 'sh-kubectl-svc', name: 'kubectl get svc', description: 'List services', emoji: '☸️', command: 'kubectl get svc -A', cliType: 'shell', category: 'k8s', tags: ['k8s', 'service'] },
  { id: 'sh-kubectl-deploy', name: 'kubectl get deploy', description: 'List deployments', emoji: '☸️', command: 'kubectl get deployments -A', cliType: 'shell', category: 'k8s', tags: ['k8s', 'deploy'] },
  { id: 'sh-kubectl-logs', name: 'kubectl logs', description: 'Pod logs', emoji: '☸️', command: 'kubectl logs -f', cliType: 'shell', category: 'k8s', tags: ['k8s', 'logs'] },
  { id: 'sh-kubectl-exec', name: 'kubectl exec', description: 'Run command in a pod', emoji: '☸️', command: 'kubectl exec -it -- /bin/sh', cliType: 'shell', category: 'k8s', tags: ['k8s', 'exec'] },
  { id: 'sh-kubectl-describe', name: 'kubectl describe', description: 'Resource details', emoji: '☸️', command: 'kubectl describe pod', cliType: 'shell', category: 'k8s', tags: ['k8s', 'describe'] },
  { id: 'sh-kubectl-apply', name: 'kubectl apply', description: 'Apply manifest', emoji: '☸️', command: 'kubectl apply -f', cliType: 'shell', category: 'k8s', tags: ['k8s', 'apply'] },
  { id: 'sh-kubectl-delete', name: 'kubectl delete', description: 'Delete resource', emoji: '☸️', command: 'kubectl delete', cliType: 'shell', category: 'k8s', tags: ['k8s', 'delete'] },
  { id: 'sh-kubectl-ctx', name: 'kubectl context', description: 'Switch context', emoji: '☸️', command: 'kubectl config get-contexts', cliType: 'shell', category: 'k8s', tags: ['k8s', 'context'] },
  { id: 'sh-kubectl-ns', name: 'kubectl namespace', description: 'List namespaces', emoji: '☸️', command: 'kubectl get namespaces', cliType: 'shell', category: 'k8s', tags: ['k8s', 'namespace'] },
  { id: 'sh-kubectl-top', name: 'kubectl top', description: 'Resource usage', emoji: '📊', command: 'kubectl top pods -A', cliType: 'shell', category: 'k8s', tags: ['k8s', 'monitor'] },
  { id: 'sh-helm-list', name: 'helm list', description: 'List Helm releases', emoji: '⛵', command: 'helm list -A', cliType: 'shell', category: 'k8s', tags: ['helm'] },
  { id: 'sh-helm-install', name: 'helm install', description: 'Install Helm chart', emoji: '⛵', command: 'helm install', cliType: 'shell', category: 'k8s', tags: ['helm'] },

  // ═══════════════════════════════════════
  // ██  패키지 매니저 (Package Managers)
  // ═══════════════════════════════════════
  // -- npm / pnpm / yarn / bun --
  { id: 'sh-npm-install', name: 'npm install', description: 'Install dependencies', emoji: '📦', command: 'npm install', cliType: 'shell', category: 'dev', tags: ['npm'] },
  { id: 'sh-npm-run', name: 'npm run', description: 'Run script', emoji: '📦', command: 'npm run', cliType: 'shell', category: 'dev', tags: ['npm'] },
  { id: 'sh-npm-outdated', name: 'npm outdated', description: 'Outdated packages', emoji: '📦', command: 'npm outdated', cliType: 'shell', category: 'dev', tags: ['npm', 'update'] },
  { id: 'sh-npm-ls', name: 'npm ls', description: 'Installed package tree', emoji: '📦', command: 'npm ls --depth=0', cliType: 'shell', category: 'dev', tags: ['npm', 'list'] },
  { id: 'sh-npm-audit', name: 'npm audit', description: 'Scan for security vulnerabilities', emoji: '🔒', command: 'npm audit', cliType: 'shell', category: 'dev', tags: ['npm', 'security'] },
  { id: 'sh-npx', name: 'npx', description: 'Run package on the fly', emoji: '📦', command: 'npx', cliType: 'shell', category: 'dev', tags: ['npm', 'npx'] },
  { id: 'sh-pnpm', name: 'pnpm install', description: 'Install pnpm dependencies', emoji: '📦', command: 'pnpm install', cliType: 'shell', category: 'dev', tags: ['pnpm'] },
  { id: 'sh-yarn', name: 'yarn', description: 'Install Yarn dependencies', emoji: '🧶', command: 'yarn', cliType: 'shell', category: 'dev', tags: ['yarn'] },
  { id: 'sh-bun', name: 'bun install', description: 'Install Bun dependencies', emoji: '🍞', command: 'bun install', cliType: 'shell', category: 'dev', tags: ['bun'] },
  { id: 'sh-bun-run', name: 'bun run', description: 'Run Bun script', emoji: '🍞', command: 'bun run', cliType: 'shell', category: 'dev', tags: ['bun'] },
  // -- brew --
  { id: 'sh-brew-install', name: 'brew install', description: 'Install Homebrew package', emoji: '🍺', command: 'brew install', cliType: 'shell', category: 'system', tags: ['brew', 'macos'] },
  { id: 'sh-brew-list', name: 'brew list', description: 'List installed packages', emoji: '🍺', command: 'brew list', cliType: 'shell', category: 'system', tags: ['brew'] },
  { id: 'sh-brew-update', name: 'brew update', description: 'Update Homebrew', emoji: '🍺', command: 'brew update && brew upgrade', cliType: 'shell', category: 'system', tags: ['brew', 'update'] },
  { id: 'sh-brew-search', name: 'brew search', description: 'Search packages', emoji: '🍺', command: 'brew search', cliType: 'shell', category: 'system', tags: ['brew', 'search'] },
  { id: 'sh-brew-info', name: 'brew info', description: 'Package info', emoji: '🍺', command: 'brew info', cliType: 'shell', category: 'system', tags: ['brew'] },
  { id: 'sh-brew-cleanup', name: 'brew cleanup', description: 'Clean up unused cache', emoji: '🧹', command: 'brew cleanup', cliType: 'shell', category: 'system', tags: ['brew', 'clean'] },
  // -- pip --
  { id: 'sh-pip-install', name: 'pip install', description: 'Install Python package', emoji: '🐍', command: 'pip install', cliType: 'shell', category: 'python', tags: ['pip', 'python'] },
  { id: 'sh-pip-list', name: 'pip list', description: 'Installed Python packages', emoji: '🐍', command: 'pip list', cliType: 'shell', category: 'python', tags: ['pip'] },
  { id: 'sh-pip-freeze', name: 'pip freeze', description: 'Generate requirements.txt', emoji: '🐍', command: 'pip freeze > requirements.txt', cliType: 'shell', category: 'python', tags: ['pip'] },
  { id: 'sh-uv', name: 'uv pip install', description: 'Ultra-fast Python package install', emoji: '⚡', command: 'uv pip install', cliType: 'shell', category: 'python', tags: ['uv', 'python'] },
  // -- cargo --
  { id: 'sh-cargo-build', name: 'cargo build', description: 'Rust build', emoji: '🦀', command: 'cargo build', cliType: 'shell', category: 'rust', tags: ['cargo', 'rust'] },
  { id: 'sh-cargo-run', name: 'cargo run', description: 'Rust run', emoji: '🦀', command: 'cargo run', cliType: 'shell', category: 'rust', tags: ['cargo', 'rust'] },
  { id: 'sh-cargo-test', name: 'cargo test', description: 'Rust test', emoji: '🦀', command: 'cargo test', cliType: 'shell', category: 'rust', tags: ['cargo', 'rust'] },
  { id: 'sh-cargo-check', name: 'cargo check', description: 'Rust type check (no build)', emoji: '🦀', command: 'cargo check', cliType: 'shell', category: 'rust', tags: ['cargo', 'rust'] },
  { id: 'sh-cargo-clippy', name: 'cargo clippy', description: 'Rust linter', emoji: '🦀', command: 'cargo clippy', cliType: 'shell', category: 'rust', tags: ['cargo', 'rust', 'lint'] },
  // -- go --
  { id: 'sh-go-build', name: 'go build', description: 'Go build', emoji: '🐹', command: 'go build ./...', cliType: 'shell', category: 'go', tags: ['go'] },
  { id: 'sh-go-run', name: 'go run', description: 'Go run', emoji: '🐹', command: 'go run .', cliType: 'shell', category: 'go', tags: ['go'] },
  { id: 'sh-go-test', name: 'go test', description: 'Go test', emoji: '🐹', command: 'go test ./...', cliType: 'shell', category: 'go', tags: ['go', 'test'] },
  { id: 'sh-go-mod', name: 'go mod tidy', description: 'Tidy Go modules', emoji: '🐹', command: 'go mod tidy', cliType: 'shell', category: 'go', tags: ['go', 'module'] },
  // -- apt (Debian/Ubuntu) --
  { id: 'sh-apt-install', name: 'apt install', description: 'Install package (Debian)', emoji: '📦', command: 'sudo apt install -y', cliType: 'shell', category: 'system', tags: ['apt', 'linux'] },
  { id: 'sh-apt-update', name: 'apt update', description: 'Refresh package list', emoji: '📦', command: 'sudo apt update && sudo apt upgrade -y', cliType: 'shell', category: 'system', tags: ['apt', 'linux'] },
  { id: 'sh-apt-search', name: 'apt search', description: 'Search packages', emoji: '📦', command: 'apt search', cliType: 'shell', category: 'system', tags: ['apt', 'linux'] },

  // ═══════════════════════════════════════
  // ██  날짜 & 시간 (Date & Time)
  // ═══════════════════════════════════════
  { id: 'sh-date', name: 'date', description: 'Current date/time', emoji: '📅', command: 'date', cliType: 'shell', category: 'system', tags: ['date'] },
  { id: 'sh-date-format', name: 'date (format)', description: 'Print formatted date', emoji: '📅', command: 'date "+%Y-%m-%d %H:%M:%S"', cliType: 'shell', category: 'system', tags: ['date', 'format'] },
  { id: 'sh-date-epoch', name: 'date (unix time)', description: 'Unix timestamp', emoji: '📅', command: 'date +%s', cliType: 'shell', category: 'system', tags: ['date', 'epoch'] },
  { id: 'sh-cal', name: 'cal', description: 'View calendar', emoji: '📅', command: 'cal', cliType: 'shell', category: 'system', tags: ['calendar'] },
  { id: 'sh-time', name: 'time', description: 'Measure command execution time', emoji: '⏱️', command: 'time', cliType: 'shell', category: 'system', tags: ['time', 'benchmark'] },
  { id: 'sh-sleep', name: 'sleep', description: 'Wait (seconds)', emoji: '😴', command: 'sleep', cliType: 'shell', category: 'system', tags: ['wait'] },

  // ═══════════════════════════════════════
  // ██  JSON / 데이터 처리
  // ═══════════════════════════════════════
  { id: 'sh-jq', name: 'jq', description: 'Parse/filter JSON', emoji: '🔧', command: 'jq .', cliType: 'shell', category: 'dev', tags: ['json', 'jq'] },
  { id: 'sh-jq-key', name: 'jq (extract key)', description: 'Extract a specific JSON key value', emoji: '🔧', command: 'jq ".key"', cliType: 'shell', category: 'dev', tags: ['json', 'jq'] },
  { id: 'sh-jq-array', name: 'jq (array)', description: 'Iterate JSON array', emoji: '🔧', command: 'jq ".[] | .name"', cliType: 'shell', category: 'dev', tags: ['json', 'jq'] },
  { id: 'sh-jq-filter', name: 'jq (filter)', description: 'Filter JSON by condition', emoji: '🔧', command: 'jq \'.[] | select(.age > 20)\'', cliType: 'shell', category: 'dev', tags: ['json', 'jq'] },
  { id: 'sh-yq', name: 'yq', description: 'Parse/convert YAML', emoji: '🔧', command: 'yq', cliType: 'shell', category: 'dev', tags: ['yaml', 'yq'] },
  { id: 'sh-csvkit', name: 'csvlook', description: 'View CSV as a table', emoji: '📊', command: 'csvlook', cliType: 'shell', category: 'dev', tags: ['csv'] },
  { id: 'sh-base64-enc', name: 'base64 (encode)', description: 'Base64 encode', emoji: '🔐', command: 'echo -n "text" | base64', cliType: 'shell', category: 'system', tags: ['encode', 'base64'] },
  { id: 'sh-base64-dec', name: 'base64 (decode)', description: 'Base64 decode', emoji: '🔐', command: 'echo "encoded" | base64 -d', cliType: 'shell', category: 'system', tags: ['decode', 'base64'] },
  { id: 'sh-md5', name: 'md5sum', description: 'MD5 hash', emoji: '🔐', command: 'md5sum', cliType: 'shell', category: 'security', tags: ['hash'] },
  { id: 'sh-sha256', name: 'sha256sum', description: 'SHA256 hash', emoji: '🔐', command: 'sha256sum', cliType: 'shell', category: 'security', tags: ['hash'] },
  { id: 'sh-openssl-rand', name: 'openssl rand', description: 'Generate random string', emoji: '🎲', command: 'openssl rand -hex 32', cliType: 'shell', category: 'security', tags: ['random'] },
  { id: 'sh-uuid', name: 'uuidgen', description: 'Generate UUID', emoji: '🎲', command: 'uuidgen', cliType: 'shell', category: 'dev', tags: ['uuid'] },

  // ═══════════════════════════════════════
  // ██  개발 도구 (Dev Tools)
  // ═══════════════════════════════════════
  { id: 'sh-node', name: 'node', description: 'Node.js REPL', emoji: '💚', command: 'node', cliType: 'shell', category: 'node', tags: ['node', 'javascript'] },
  { id: 'sh-node-eval', name: 'node -e', description: 'Run a Node.js one-liner', emoji: '💚', command: 'node -e "console.log()"', cliType: 'shell', category: 'node', tags: ['node'] },
  { id: 'sh-python', name: 'python3', description: 'Python REPL', emoji: '🐍', command: 'python3', cliType: 'shell', category: 'python', tags: ['python'] },
  { id: 'sh-python-eval', name: 'python -c', description: 'Run a Python one-liner', emoji: '🐍', command: 'python3 -c "print()"', cliType: 'shell', category: 'python', tags: ['python'] },
  { id: 'sh-tsc', name: 'tsc --noEmit', description: 'TypeScript type check', emoji: '🔷', command: 'npx tsc --noEmit', cliType: 'shell', category: 'dev', tags: ['typescript'] },
  { id: 'sh-eslint', name: 'eslint', description: 'ESLint lint', emoji: '🔍', command: 'npx eslint .', cliType: 'shell', category: 'dev', tags: ['lint', 'eslint'] },
  { id: 'sh-prettier', name: 'prettier', description: 'Format code', emoji: '✨', command: 'npx prettier --write .', cliType: 'shell', category: 'dev', tags: ['format'] },
  { id: 'sh-jest', name: 'jest', description: 'Jest tests', emoji: '🧪', command: 'npx jest', cliType: 'shell', category: 'testing', tags: ['test', 'jest'] },
  { id: 'sh-vitest', name: 'vitest', description: 'Vitest tests', emoji: '🧪', command: 'npx vitest', cliType: 'shell', category: 'testing', tags: ['test', 'vitest'] },
  { id: 'sh-pytest', name: 'pytest', description: 'Python tests', emoji: '🧪', command: 'pytest -v', cliType: 'shell', category: 'testing', tags: ['test', 'python'] },
  { id: 'sh-make', name: 'make', description: 'Makefile build', emoji: '🔨', command: 'make', cliType: 'shell', category: 'dev', tags: ['build', 'make'] },
  { id: 'sh-cmake', name: 'cmake', description: 'CMake build', emoji: '🔨', command: 'cmake --build .', cliType: 'shell', category: 'dev', tags: ['build', 'cmake'] },
  { id: 'sh-gcc', name: 'gcc', description: 'Compile C', emoji: '🔨', command: 'gcc -o output', cliType: 'shell', category: 'dev', tags: ['c', 'compile'] },
  { id: 'sh-cloc', name: 'cloc', description: 'Lines-of-code statistics', emoji: '📊', command: 'cloc .', cliType: 'shell', category: 'dev', tags: ['stats', 'lines'] },
  { id: 'sh-tokei', name: 'tokei', description: 'Code statistics (tokei)', emoji: '📊', command: 'tokei', cliType: 'shell', category: 'dev', tags: ['stats'] },
  { id: 'sh-http-server', name: 'http-server', description: 'Simple HTTP server', emoji: '🌐', command: 'npx http-server -p 8080', cliType: 'shell', category: 'dev', tags: ['server', 'http'] },
  { id: 'sh-python-http', name: 'python http.server', description: 'Simple Python server', emoji: '🐍', command: 'python3 -m http.server 8080', cliType: 'shell', category: 'dev', tags: ['server', 'python'] },
  { id: 'sh-ngrok', name: 'ngrok', description: 'Expose local server publicly', emoji: '🌍', command: 'ngrok http 3000', cliType: 'shell', category: 'dev', tags: ['tunnel', 'ngrok'] },
  { id: 'sh-strace', name: 'strace', description: 'Trace system calls (Linux)', emoji: '🔬', command: 'strace -p', cliType: 'shell', category: 'dev', tags: ['debug', 'trace'] },
  { id: 'sh-ltrace', name: 'ltrace', description: 'Trace library calls', emoji: '🔬', command: 'ltrace', cliType: 'shell', category: 'dev', tags: ['debug', 'trace'] },
  { id: 'sh-dtruss', name: 'dtruss', description: 'Trace system calls (macOS)', emoji: '🔬', command: 'sudo dtruss', cliType: 'shell', category: 'dev', tags: ['debug', 'trace', 'macos'] },

  // ═══════════════════════════════════════
  // ██  DB CLI
  // ═══════════════════════════════════════
  { id: 'sh-psql', name: 'psql', description: 'PostgreSQL CLI', emoji: '🐘', command: 'psql', cliType: 'shell', category: 'db', tags: ['postgres', 'sql'] },
  { id: 'sh-mysql', name: 'mysql', description: 'MySQL CLI', emoji: '🐬', command: 'mysql -u root -p', cliType: 'shell', category: 'db', tags: ['mysql', 'sql'] },
  { id: 'sh-sqlite3', name: 'sqlite3', description: 'SQLite CLI', emoji: '📀', command: 'sqlite3', cliType: 'shell', category: 'db', tags: ['sqlite', 'sql'] },
  { id: 'sh-redis-cli', name: 'redis-cli', description: 'Redis CLI', emoji: '🔴', command: 'redis-cli', cliType: 'shell', category: 'db', tags: ['redis'] },
  { id: 'sh-mongosh', name: 'mongosh', description: 'MongoDB Shell', emoji: '🍃', command: 'mongosh', cliType: 'shell', category: 'db', tags: ['mongodb'] },

  // ═══════════════════════════════════════
  // ██  Cloud CLI
  // ═══════════════════════════════════════
  { id: 'sh-aws-s3', name: 'aws s3 ls', description: 'List AWS S3 buckets', emoji: '☁️', command: 'aws s3 ls', cliType: 'shell', category: 'cloud', tags: ['aws', 's3'] },
  { id: 'sh-aws-ec2', name: 'aws ec2', description: 'List EC2 instances', emoji: '☁️', command: 'aws ec2 describe-instances --query "Reservations[].Instances[].[InstanceId,State.Name,Tags[?Key==\'Name\'].Value|[0]]" --output table', cliType: 'shell', category: 'cloud', tags: ['aws', 'ec2'] },
  { id: 'sh-gcloud-list', name: 'gcloud instances', description: 'List GCP VMs', emoji: '☁️', command: 'gcloud compute instances list', cliType: 'shell', category: 'cloud', tags: ['gcp'] },
  { id: 'sh-az-vm', name: 'az vm list', description: 'List Azure VMs', emoji: '☁️', command: 'az vm list -o table', cliType: 'shell', category: 'cloud', tags: ['azure'] },
  { id: 'sh-terraform-plan', name: 'terraform plan', description: 'Terraform change plan', emoji: '🏗️', command: 'terraform plan', cliType: 'shell', category: 'cloud', tags: ['terraform', 'iac'] },
  { id: 'sh-terraform-apply', name: 'terraform apply', description: 'Apply Terraform', emoji: '🏗️', command: 'terraform apply', cliType: 'shell', category: 'cloud', tags: ['terraform', 'iac'] },

  // ═══════════════════════════════════════
  // ██  보안 (Security)
  // ═══════════════════════════════════════
  { id: 'sh-openssl-cert', name: 'openssl view certificate', description: 'SSL certificate info', emoji: '🔐', command: 'openssl x509 -in cert.pem -text -noout', cliType: 'shell', category: 'security', tags: ['ssl', 'cert'] },
  { id: 'sh-openssl-connect', name: 'openssl connection test', description: 'SSL/TLS connection test', emoji: '🔐', command: 'openssl s_client -connect', cliType: 'shell', category: 'security', tags: ['ssl'] },
  { id: 'sh-gpg-enc', name: 'gpg (encrypt)', description: 'GPG file encryption', emoji: '🔐', command: 'gpg -c', cliType: 'shell', category: 'security', tags: ['gpg', 'encrypt'] },
  { id: 'sh-gpg-dec', name: 'gpg (decrypt)', description: 'GPG file decryption', emoji: '🔐', command: 'gpg -d', cliType: 'shell', category: 'security', tags: ['gpg', 'decrypt'] },
  { id: 'sh-chmod-x', name: 'chmod +x', description: 'Grant execute permission', emoji: '🔐', command: 'chmod +x', cliType: 'shell', category: 'security', tags: ['permission'] },

  // ═══════════════════════════════════════
  // ██  macOS 전용
  // ═══════════════════════════════════════
  { id: 'sh-open', name: 'open', description: 'Open file/URL with default app', emoji: '🍎', command: 'open', cliType: 'shell', category: 'system', tags: ['macos', 'open'] },
  { id: 'sh-open-finder', name: 'open . (Finder)', description: 'Open current folder in Finder', emoji: '🍎', command: 'open .', cliType: 'shell', category: 'system', tags: ['macos', 'finder'] },
  { id: 'sh-pbcopy', name: 'pbcopy', description: 'Copy to clipboard (macOS)', emoji: '📋', command: 'pbcopy', cliType: 'shell', category: 'system', tags: ['macos', 'clipboard'] },
  { id: 'sh-pbpaste', name: 'pbpaste', description: 'Paste clipboard contents', emoji: '📋', command: 'pbpaste', cliType: 'shell', category: 'system', tags: ['macos', 'clipboard'] },
  { id: 'sh-say', name: 'say', description: 'Text-to-speech output (TTS)', emoji: '🔊', command: 'say', cliType: 'shell', category: 'system', tags: ['macos', 'tts'] },
  { id: 'sh-caffeinate', name: 'caffeinate', description: 'Prevent sleep', emoji: '☕', command: 'caffeinate -d', cliType: 'shell', category: 'system', tags: ['macos'] },
  { id: 'sh-defaults', name: 'defaults', description: 'Read/write macOS settings', emoji: '⚙️', command: 'defaults read', cliType: 'shell', category: 'system', tags: ['macos', 'settings'] },
  { id: 'sh-mdfind', name: 'mdfind', description: 'Spotlight search (CLI)', emoji: '🔍', command: 'mdfind', cliType: 'shell', category: 'system', tags: ['macos', 'search'] },
  { id: 'sh-sw-vers', name: 'sw_vers', description: 'macOS version info', emoji: '🍎', command: 'sw_vers', cliType: 'shell', category: 'system', tags: ['macos', 'version'] },
  { id: 'sh-system-profiler', name: 'system_profiler', description: 'Hardware info (macOS)', emoji: '🍎', command: 'system_profiler SPHardwareDataType', cliType: 'shell', category: 'system', tags: ['macos', 'hardware'] },
  { id: 'sh-diskutil', name: 'diskutil', description: 'Disk utility (macOS)', emoji: '💾', command: 'diskutil list', cliType: 'shell', category: 'system', tags: ['macos', 'disk'] },
  { id: 'sh-launchctl', name: 'launchctl', description: 'Manage macOS services', emoji: '⚙️', command: 'launchctl list', cliType: 'shell', category: 'system', tags: ['macos', 'service'] },
  { id: 'sh-dscl', name: 'dscl', description: 'macOS directory service', emoji: '👤', command: 'dscl . -list /Users', cliType: 'shell', category: 'system', tags: ['macos', 'user'] },
  { id: 'sh-sips', name: 'sips', description: 'Convert image (macOS)', emoji: '🖼️', command: 'sips -Z 800', cliType: 'shell', category: 'system', tags: ['macos', 'image'] },
  { id: 'sh-screencapture', name: 'screencapture', description: 'Screenshot (macOS)', emoji: '📸', command: 'screencapture -x screenshot.png', cliType: 'shell', category: 'system', tags: ['macos', 'screenshot'] },

  // ═══════════════════════════════════════
  // ██  기타 유용한 명령 (Misc)
  // ═══════════════════════════════════════
  { id: 'sh-yes', name: 'yes', description: 'Infinite repeated output', emoji: '♾️', command: 'yes', cliType: 'shell', category: 'system', tags: ['misc'] },
  { id: 'sh-seq', name: 'seq', description: 'Generate number sequence', emoji: '🔢', command: 'seq 1 10', cliType: 'shell', category: 'system', tags: ['number'] },
  { id: 'sh-bc', name: 'bc', description: 'Calculator', emoji: '🧮', command: 'bc -l', cliType: 'shell', category: 'system', tags: ['math', 'calc'] },
  { id: 'sh-expr', name: 'expr', description: 'Evaluate expression', emoji: '🧮', command: 'expr', cliType: 'shell', category: 'system', tags: ['math'] },
  { id: 'sh-clear', name: 'clear', description: 'Clear screen', emoji: '🧹', command: 'clear', cliType: 'shell', category: 'system', tags: ['clear'] },
  { id: 'sh-reset', name: 'reset', description: 'Reset terminal', emoji: '🧹', command: 'reset', cliType: 'shell', category: 'system', tags: ['reset'] },
  { id: 'sh-exit', name: 'exit', description: 'Exit shell', emoji: '🚪', command: 'exit', cliType: 'shell', category: 'system', tags: ['exit'] },
  { id: 'sh-source', name: 'source', description: 'Run script in current shell', emoji: '📜', command: 'source', cliType: 'shell', category: 'system', tags: ['script'] },
  { id: 'sh-screen', name: 'screen', description: 'Manage terminal sessions', emoji: '🖥️', command: 'screen', cliType: 'shell', category: 'system', tags: ['session'] },
  { id: 'sh-tmux', name: 'tmux', description: 'Terminal multiplexer', emoji: '🖥️', command: 'tmux', cliType: 'shell', category: 'system', tags: ['session', 'tmux'] },
  { id: 'sh-tmux-ls', name: 'tmux ls', description: 'List tmux sessions', emoji: '🖥️', command: 'tmux ls', cliType: 'shell', category: 'system', tags: ['tmux'] },
  { id: 'sh-fzf', name: 'fzf', description: 'Fuzzy finder', emoji: '🔍', command: 'fzf', cliType: 'shell', category: 'system', tags: ['search', 'fuzzy'] },
  { id: 'sh-bat', name: 'bat', description: 'cat with syntax highlighting', emoji: '🦇', command: 'bat', cliType: 'shell', category: 'system', tags: ['cat', 'highlight'] },
  { id: 'sh-exa', name: 'eza (exa)', description: 'ls with color/icons', emoji: '📂', command: 'eza -la --icons', cliType: 'shell', category: 'system', tags: ['ls', 'modern'] },
  { id: 'sh-fd', name: 'fd', description: 'find alternative (faster)', emoji: '🔎', command: 'fd', cliType: 'shell', category: 'system', tags: ['find', 'fast'] },
  { id: 'sh-dust', name: 'dust', description: 'du alternative (visual)', emoji: '💾', command: 'dust', cliType: 'shell', category: 'system', tags: ['disk', 'modern'] },
  { id: 'sh-procs', name: 'procs', description: 'ps alternative (Rust)', emoji: '⚙️', command: 'procs', cliType: 'shell', category: 'system', tags: ['process', 'modern'] },
  { id: 'sh-hyperfine', name: 'hyperfine', description: 'Command benchmark', emoji: '⏱️', command: 'hyperfine', cliType: 'shell', category: 'dev', tags: ['benchmark'] },
  { id: 'sh-neofetch', name: 'neofetch', description: 'System info + ASCII art', emoji: '🎨', command: 'neofetch', cliType: 'shell', category: 'system', tags: ['info', 'ascii'] },
  { id: 'sh-figlet', name: 'figlet', description: 'ASCII art text', emoji: '🎨', command: 'figlet', cliType: 'shell', category: 'system', tags: ['ascii', 'art'] },
  { id: 'sh-cowsay', name: 'cowsay', description: 'Talking cow ASCII art', emoji: '🐄', command: 'cowsay', cliType: 'shell', category: 'system', tags: ['ascii', 'fun'] },
  { id: 'sh-fortune', name: 'fortune', description: 'Random quote/aphorism', emoji: '🔮', command: 'fortune', cliType: 'shell', category: 'system', tags: ['fun'] },
  { id: 'sh-cmatrix', name: 'cmatrix', description: 'Matrix effect', emoji: '🟩', command: 'cmatrix', cliType: 'shell', category: 'system', tags: ['fun', 'matrix'] },
  { id: 'sh-gh-pr', name: 'gh pr list', description: 'List GitHub PRs', emoji: '🐙', command: 'gh pr list', cliType: 'shell', category: 'git', tags: ['github', 'pr'] },
  { id: 'sh-gh-issue', name: 'gh issue list', description: 'List GitHub issues', emoji: '🐙', command: 'gh issue list', cliType: 'shell', category: 'git', tags: ['github', 'issue'] },
  { id: 'sh-gh-repo', name: 'gh repo view', description: 'GitHub repository info', emoji: '🐙', command: 'gh repo view', cliType: 'shell', category: 'git', tags: ['github'] },
  { id: 'sh-gh-run', name: 'gh run list', description: 'List GitHub Actions runs', emoji: '🐙', command: 'gh run list', cliType: 'shell', category: 'git', tags: ['github', 'ci'] },

  // ═══════════════════════════════════════
  // ██  FFmpeg / 미디어 (Media)
  // ═══════════════════════════════════════
  { id: 'sh-ffmpeg-info', name: 'ffmpeg info', description: 'Check media file info', emoji: '🎬', command: 'ffprobe -v quiet -print_format json -show_format -show_streams', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'media'] },
  { id: 'sh-ffmpeg-mp4', name: 'ffmpeg → MP4', description: 'Convert video to MP4', emoji: '🎬', command: 'ffmpeg -i input.mkv -c:v libx264 -crf 23 output.mp4', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'video'] },
  { id: 'sh-ffmpeg-mp3', name: 'ffmpeg → MP3', description: 'Convert audio to MP3', emoji: '🎵', command: 'ffmpeg -i input.wav -b:a 192k output.mp3', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'audio'] },
  { id: 'sh-ffmpeg-gif', name: 'ffmpeg → GIF', description: 'Convert video to GIF', emoji: '🎬', command: 'ffmpeg -i input.mp4 -vf "fps=10,scale=480:-1" output.gif', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'gif'] },
  { id: 'sh-ffmpeg-trim', name: 'ffmpeg trim', description: 'Trim video', emoji: '✂️', command: 'ffmpeg -i input.mp4 -ss 00:00:10 -to 00:00:30 -c copy output.mp4', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'trim'] },
  { id: 'sh-ffmpeg-audio-extract', name: 'ffmpeg extract audio', description: 'Extract audio from video', emoji: '🎵', command: 'ffmpeg -i input.mp4 -vn -acodec copy output.aac', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'audio'] },
  { id: 'sh-ffmpeg-resize', name: 'ffmpeg resize', description: 'Change video resolution', emoji: '🎬', command: 'ffmpeg -i input.mp4 -vf scale=1280:720 output.mp4', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'resize'] },
  { id: 'sh-ffmpeg-concat', name: 'ffmpeg concat', description: 'Concatenate video files', emoji: '🎬', command: 'ffmpeg -f concat -safe 0 -i list.txt -c copy output.mp4', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'concat'] },
  { id: 'sh-ffmpeg-thumb', name: 'ffmpeg thumbnail', description: 'Extract video thumbnail', emoji: '🖼️', command: 'ffmpeg -i input.mp4 -ss 00:00:05 -vframes 1 thumb.jpg', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'thumbnail'] },
  { id: 'sh-ffmpeg-compress', name: 'ffmpeg compress', description: 'Reduce video file size', emoji: '🎬', command: 'ffmpeg -i input.mp4 -c:v libx264 -crf 28 -preset fast output.mp4', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'compress'] },
  { id: 'sh-ffmpeg-fps', name: 'ffmpeg change FPS', description: 'Change frame rate', emoji: '🎬', command: 'ffmpeg -i input.mp4 -r 30 output.mp4', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'fps'] },
  { id: 'sh-ffmpeg-rotate', name: 'ffmpeg rotate', description: 'Rotate video 90 degrees', emoji: '🔄', command: 'ffmpeg -i input.mp4 -vf "transpose=1" output.mp4', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'rotate'] },
  { id: 'sh-ffmpeg-speed', name: 'ffmpeg change speed', description: 'Speed up video 2x', emoji: '⏩', command: 'ffmpeg -i input.mp4 -filter:v "setpts=0.5*PTS" -filter:a "atempo=2.0" output.mp4', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'speed'] },
  { id: 'sh-ffmpeg-subtitle', name: 'ffmpeg merge subtitles', description: 'Merge subtitle file', emoji: '💬', command: 'ffmpeg -i input.mp4 -i sub.srt -c copy -c:s mov_text output.mp4', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'subtitle'] },
  { id: 'sh-ffmpeg-screen', name: 'ffmpeg screen record', description: 'Screen recording (macOS)', emoji: '📹', command: 'ffmpeg -f avfoundation -i "1:0" -c:v libx264 -r 30 output.mp4', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'screen', 'record'] },
  { id: 'sh-ffplay', name: 'ffplay', description: 'Play media', emoji: '▶️', command: 'ffplay', cliType: 'shell', category: 'dev', tags: ['ffmpeg', 'play'] },
  { id: 'sh-sox', name: 'sox', description: 'Audio processing (SoX)', emoji: '🎵', command: 'sox input.wav output.wav', cliType: 'shell', category: 'dev', tags: ['audio', 'sox'] },
  { id: 'sh-yt-dlp', name: 'yt-dlp', description: 'Video downloader', emoji: '📥', command: 'yt-dlp', cliType: 'shell', category: 'dev', tags: ['download', 'video'] },
  { id: 'sh-yt-dlp-mp3', name: 'yt-dlp → MP3', description: 'Download audio only', emoji: '🎵', command: 'yt-dlp -x --audio-format mp3', cliType: 'shell', category: 'dev', tags: ['download', 'audio'] },

  // ═══════════════════════════════════════
  // ██  ImageMagick / 이미지 (Image)
  // ═══════════════════════════════════════
  { id: 'sh-magick-resize', name: 'magick resize', description: 'Resize image', emoji: '🖼️', command: 'magick input.png -resize 800x600 output.png', cliType: 'shell', category: 'dev', tags: ['image', 'resize'] },
  { id: 'sh-magick-convert', name: 'magick convert', description: 'Convert image format', emoji: '🖼️', command: 'magick input.png output.jpg', cliType: 'shell', category: 'dev', tags: ['image', 'convert'] },
  { id: 'sh-magick-crop', name: 'magick crop', description: 'Crop image', emoji: '✂️', command: 'magick input.png -crop 300x300+50+50 output.png', cliType: 'shell', category: 'dev', tags: ['image', 'crop'] },
  { id: 'sh-magick-rotate', name: 'magick rotate', description: 'Rotate image', emoji: '🔄', command: 'magick input.png -rotate 90 output.png', cliType: 'shell', category: 'dev', tags: ['image', 'rotate'] },
  { id: 'sh-magick-blur', name: 'magick blur', description: 'Blur image', emoji: '🖼️', command: 'magick input.png -blur 0x8 output.png', cliType: 'shell', category: 'dev', tags: ['image', 'blur'] },
  { id: 'sh-magick-text', name: 'magick text', description: 'Add text to image', emoji: '✍️', command: 'magick input.png -pointsize 36 -annotate +50+50 "Hello" output.png', cliType: 'shell', category: 'dev', tags: ['image', 'text'] },
  { id: 'sh-magick-montage', name: 'magick montage', description: 'Image collage', emoji: '🖼️', command: 'magick montage *.jpg -geometry +5+5 -tile 3x montage.jpg', cliType: 'shell', category: 'dev', tags: ['image', 'montage'] },
  { id: 'sh-magick-info', name: 'magick identify', description: 'Image info', emoji: '🔍', command: 'magick identify -verbose', cliType: 'shell', category: 'dev', tags: ['image', 'info'] },
  { id: 'sh-magick-optimize', name: 'magick optimize', description: 'Reduce image size', emoji: '🗜️', command: 'magick input.png -strip -quality 85 output.png', cliType: 'shell', category: 'dev', tags: ['image', 'optimize'] },
  { id: 'sh-magick-pdf', name: 'magick → PDF', description: 'Images to PDF', emoji: '📄', command: 'magick *.jpg output.pdf', cliType: 'shell', category: 'dev', tags: ['image', 'pdf'] },
  { id: 'sh-magick-gif', name: 'magick → GIF', description: 'Image sequence to GIF', emoji: '🎞️', command: 'magick -delay 10 -loop 0 *.png output.gif', cliType: 'shell', category: 'dev', tags: ['image', 'gif'] },
  { id: 'sh-optipng', name: 'optipng', description: 'Lossless PNG optimization', emoji: '🖼️', command: 'optipng -o5', cliType: 'shell', category: 'dev', tags: ['image', 'optimize'] },
  { id: 'sh-jpegoptim', name: 'jpegoptim', description: 'Optimize JPEG', emoji: '🖼️', command: 'jpegoptim --strip-all -m80', cliType: 'shell', category: 'dev', tags: ['image', 'optimize'] },
  { id: 'sh-svgo', name: 'svgo', description: 'Optimize SVG', emoji: '🖼️', command: 'npx svgo', cliType: 'shell', category: 'dev', tags: ['svg', 'optimize'] },
  { id: 'sh-exiftool', name: 'exiftool', description: 'Image EXIF metadata', emoji: '📷', command: 'exiftool', cliType: 'shell', category: 'dev', tags: ['image', 'exif'] },
  { id: 'sh-exiftool-strip', name: 'exiftool strip metadata', description: 'Remove EXIF metadata', emoji: '📷', command: 'exiftool -all=', cliType: 'shell', category: 'dev', tags: ['image', 'privacy'] },
  { id: 'sh-qrencode', name: 'qrencode', description: 'Generate QR code', emoji: '📱', command: 'qrencode -o qr.png "https://example.com"', cliType: 'shell', category: 'dev', tags: ['qr', 'encode'] },

  // ═══════════════════════════════════════
  // ██  문서 변환 (Document)
  // ═══════════════════════════════════════
  { id: 'sh-pandoc-md-pdf', name: 'pandoc MD→PDF', description: 'Markdown to PDF', emoji: '📄', command: 'pandoc input.md -o output.pdf', cliType: 'shell', category: 'dev', tags: ['pandoc', 'pdf'] },
  { id: 'sh-pandoc-md-docx', name: 'pandoc MD→DOCX', description: 'Markdown to Word', emoji: '📄', command: 'pandoc input.md -o output.docx', cliType: 'shell', category: 'dev', tags: ['pandoc', 'docx'] },
  { id: 'sh-pandoc-md-html', name: 'pandoc MD→HTML', description: 'Markdown to HTML', emoji: '📄', command: 'pandoc input.md -s -o output.html', cliType: 'shell', category: 'dev', tags: ['pandoc', 'html'] },
  { id: 'sh-pandoc-docx-md', name: 'pandoc DOCX→MD', description: 'Word to Markdown', emoji: '📄', command: 'pandoc input.docx -t markdown -o output.md', cliType: 'shell', category: 'dev', tags: ['pandoc', 'markdown'] },
  { id: 'sh-wkhtmltopdf', name: 'wkhtmltopdf', description: 'HTML to PDF', emoji: '📄', command: 'wkhtmltopdf', cliType: 'shell', category: 'dev', tags: ['html', 'pdf'] },
  { id: 'sh-ghostscript', name: 'gs (Ghostscript)', description: 'Compress/convert PDF', emoji: '📄', command: 'gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -o output.pdf input.pdf', cliType: 'shell', category: 'dev', tags: ['pdf', 'compress'] },
  { id: 'sh-pdftotext', name: 'pdftotext', description: 'Extract text from PDF', emoji: '📄', command: 'pdftotext', cliType: 'shell', category: 'dev', tags: ['pdf', 'text'] },
  { id: 'sh-qpdf-merge', name: 'qpdf merge', description: 'Merge PDFs', emoji: '📄', command: 'qpdf --empty --pages *.pdf -- merged.pdf', cliType: 'shell', category: 'dev', tags: ['pdf', 'merge'] },
  { id: 'sh-qpdf-split', name: 'qpdf split', description: 'Split PDF', emoji: '📄', command: 'qpdf input.pdf --pages . 1-5 -- output.pdf', cliType: 'shell', category: 'dev', tags: ['pdf', 'split'] },

  // ═══════════════════════════════════════
  // ██  Linux systemd / 서비스 관리
  // ═══════════════════════════════════════
  { id: 'sh-systemctl-status', name: 'systemctl status', description: 'Check service status', emoji: '⚙️', command: 'systemctl status', cliType: 'shell', category: 'system', tags: ['systemd', 'service'] },
  { id: 'sh-systemctl-start', name: 'systemctl start', description: 'Start service', emoji: '▶️', command: 'sudo systemctl start', cliType: 'shell', category: 'system', tags: ['systemd'] },
  { id: 'sh-systemctl-stop', name: 'systemctl stop', description: 'Stop service', emoji: '⏹️', command: 'sudo systemctl stop', cliType: 'shell', category: 'system', tags: ['systemd'] },
  { id: 'sh-systemctl-restart', name: 'systemctl restart', description: 'Restart service', emoji: '🔄', command: 'sudo systemctl restart', cliType: 'shell', category: 'system', tags: ['systemd'] },
  { id: 'sh-systemctl-enable', name: 'systemctl enable', description: 'Auto-start on boot', emoji: '✅', command: 'sudo systemctl enable', cliType: 'shell', category: 'system', tags: ['systemd'] },
  { id: 'sh-systemctl-list', name: 'systemctl list', description: 'List running services', emoji: '📋', command: 'systemctl list-units --type=service --state=running', cliType: 'shell', category: 'system', tags: ['systemd'] },
  { id: 'sh-systemctl-failed', name: 'systemctl failed', description: 'List failed services', emoji: '❌', command: 'systemctl --failed', cliType: 'shell', category: 'system', tags: ['systemd'] },
  { id: 'sh-journalctl', name: 'journalctl', description: 'systemd journal log', emoji: '📋', command: 'journalctl -xe', cliType: 'shell', category: 'system', tags: ['systemd', 'log'] },
  { id: 'sh-journalctl-unit', name: 'journalctl -u', description: 'Logs for a specific service', emoji: '📋', command: 'journalctl -u', cliType: 'shell', category: 'system', tags: ['systemd', 'log'] },
  { id: 'sh-journalctl-boot', name: 'journalctl -b', description: 'Current boot log', emoji: '📋', command: 'journalctl -b', cliType: 'shell', category: 'system', tags: ['systemd', 'boot'] },
  { id: 'sh-journalctl-follow', name: 'journalctl -f', description: 'Follow logs in real time', emoji: '📋', command: 'journalctl -f', cliType: 'shell', category: 'system', tags: ['systemd', 'tail'] },
  { id: 'sh-timedatectl', name: 'timedatectl', description: 'Check/change timezone', emoji: '🕐', command: 'timedatectl', cliType: 'shell', category: 'system', tags: ['time', 'timezone'] },
  { id: 'sh-hostnamectl', name: 'hostnamectl', description: 'Check/change hostname', emoji: '🖥️', command: 'hostnamectl', cliType: 'shell', category: 'system', tags: ['hostname'] },
  { id: 'sh-loginctl', name: 'loginctl', description: 'Manage login sessions', emoji: '👤', command: 'loginctl list-sessions', cliType: 'shell', category: 'system', tags: ['session'] },

  // ═══════════════════════════════════════
  // ██  버전 관리자 (Version Managers)
  // ═══════════════════════════════════════
  { id: 'sh-nvm-list', name: 'nvm ls', description: 'List installed Node.js versions', emoji: '💚', command: 'nvm ls', cliType: 'shell', category: 'node', tags: ['nvm', 'node'] },
  { id: 'sh-nvm-install', name: 'nvm install', description: 'Install Node.js version', emoji: '💚', command: 'nvm install --lts', cliType: 'shell', category: 'node', tags: ['nvm', 'node'] },
  { id: 'sh-nvm-use', name: 'nvm use', description: 'Switch Node.js version', emoji: '💚', command: 'nvm use', cliType: 'shell', category: 'node', tags: ['nvm', 'node'] },
  { id: 'sh-fnm-list', name: 'fnm ls', description: 'List fnm Node versions', emoji: '💚', command: 'fnm ls', cliType: 'shell', category: 'node', tags: ['fnm', 'node'] },
  { id: 'sh-fnm-use', name: 'fnm use', description: 'Switch fnm Node version', emoji: '💚', command: 'fnm use', cliType: 'shell', category: 'node', tags: ['fnm', 'node'] },
  { id: 'sh-pyenv-versions', name: 'pyenv versions', description: 'List Python versions', emoji: '🐍', command: 'pyenv versions', cliType: 'shell', category: 'python', tags: ['pyenv'] },
  { id: 'sh-pyenv-install', name: 'pyenv install', description: 'Install Python version', emoji: '🐍', command: 'pyenv install', cliType: 'shell', category: 'python', tags: ['pyenv'] },
  { id: 'sh-rbenv-versions', name: 'rbenv versions', description: 'List Ruby versions', emoji: '💎', command: 'rbenv versions', cliType: 'shell', category: 'dev', tags: ['rbenv', 'ruby'] },
  { id: 'sh-rustup-show', name: 'rustup show', description: 'Rust toolchain info', emoji: '🦀', command: 'rustup show', cliType: 'shell', category: 'rust', tags: ['rustup'] },
  { id: 'sh-rustup-update', name: 'rustup update', description: 'Update Rust toolchain', emoji: '🦀', command: 'rustup update', cliType: 'shell', category: 'rust', tags: ['rustup'] },
  { id: 'sh-sdkman', name: 'sdk list java', description: 'List Java versions (SDKMAN)', emoji: '☕', command: 'sdk list java', cliType: 'shell', category: 'java', tags: ['sdkman', 'java'] },
  { id: 'sh-asdf-list', name: 'asdf list', description: 'List asdf installed versions', emoji: '📦', command: 'asdf list', cliType: 'shell', category: 'dev', tags: ['asdf'] },
  { id: 'sh-mise-list', name: 'mise ls', description: 'List mise-installed tools', emoji: '📦', command: 'mise ls', cliType: 'shell', category: 'dev', tags: ['mise'] },

  // ═══════════════════════════════════════
  // ██  가상환경 (Virtual Env)
  // ═══════════════════════════════════════
  { id: 'sh-venv-create', name: 'create python venv', description: 'Create Python virtualenv', emoji: '🐍', command: 'python3 -m venv .venv', cliType: 'shell', category: 'python', tags: ['venv'] },
  { id: 'sh-venv-activate', name: 'venv activate', description: 'Activate virtual environment', emoji: '🐍', command: 'source .venv/bin/activate', cliType: 'shell', category: 'python', tags: ['venv'] },
  { id: 'sh-conda-create', name: 'conda create', description: 'Create Conda environment', emoji: '🐍', command: 'conda create -n myenv python=3.12', cliType: 'shell', category: 'python', tags: ['conda'] },
  { id: 'sh-conda-activate', name: 'conda activate', description: 'Activate Conda environment', emoji: '🐍', command: 'conda activate myenv', cliType: 'shell', category: 'python', tags: ['conda'] },
  { id: 'sh-conda-list', name: 'conda list', description: 'List Conda packages', emoji: '🐍', command: 'conda list', cliType: 'shell', category: 'python', tags: ['conda'] },
  { id: 'sh-conda-envs', name: 'conda envs', description: 'List Conda environments', emoji: '🐍', command: 'conda env list', cliType: 'shell', category: 'python', tags: ['conda'] },
  { id: 'sh-poetry-install', name: 'poetry install', description: 'Install Poetry dependencies', emoji: '🐍', command: 'poetry install', cliType: 'shell', category: 'python', tags: ['poetry'] },
  { id: 'sh-poetry-run', name: 'poetry run', description: 'Run in Poetry environment', emoji: '🐍', command: 'poetry run', cliType: 'shell', category: 'python', tags: ['poetry'] },
  { id: 'sh-pipx', name: 'pipx install', description: 'Install standalone Python CLI tool', emoji: '🐍', command: 'pipx install', cliType: 'shell', category: 'python', tags: ['pipx'] },

  // ═══════════════════════════════════════
  // ██  CI/CD & 빌드 도구
  // ═══════════════════════════════════════
  { id: 'sh-gh-workflow-run', name: 'gh workflow run', description: 'Manually run GitHub Actions', emoji: '🐙', command: 'gh workflow run', cliType: 'shell', category: 'cicd', tags: ['github', 'ci'] },
  { id: 'sh-gh-run-view', name: 'gh run view', description: 'View CI run results', emoji: '🐙', command: 'gh run view --log', cliType: 'shell', category: 'cicd', tags: ['github', 'ci'] },
  { id: 'sh-gh-release', name: 'gh release create', description: 'Create GitHub release', emoji: '🐙', command: 'gh release create', cliType: 'shell', category: 'git', tags: ['github', 'release'] },
  { id: 'sh-act', name: 'act', description: 'Run GitHub Actions locally', emoji: '🎭', command: 'act', cliType: 'shell', category: 'cicd', tags: ['github', 'ci', 'local'] },
  { id: 'sh-gradle-build', name: 'gradle build', description: 'Gradle build', emoji: '🐘', command: './gradlew build', cliType: 'shell', category: 'java', tags: ['gradle', 'java'] },
  { id: 'sh-gradle-test', name: 'gradle test', description: 'Gradle test', emoji: '🧪', command: './gradlew test', cliType: 'shell', category: 'java', tags: ['gradle', 'test'] },
  { id: 'sh-mvn-clean', name: 'mvn clean install', description: 'Maven build', emoji: '🏗️', command: 'mvn clean install', cliType: 'shell', category: 'java', tags: ['maven', 'java'] },
  { id: 'sh-mvn-test', name: 'mvn test', description: 'Maven test', emoji: '🧪', command: 'mvn test', cliType: 'shell', category: 'java', tags: ['maven', 'test'] },
  { id: 'sh-bazel-build', name: 'bazel build', description: 'Bazel build', emoji: '🏗️', command: 'bazel build //...', cliType: 'shell', category: 'dev', tags: ['bazel'] },
  { id: 'sh-nx-run', name: 'nx run', description: 'Run Nx task', emoji: '📦', command: 'npx nx run', cliType: 'shell', category: 'dev', tags: ['nx', 'monorepo'] },
  { id: 'sh-turbo-run', name: 'turbo run', description: 'Turborepo build', emoji: '🚀', command: 'npx turbo run build', cliType: 'shell', category: 'dev', tags: ['turbo', 'monorepo'] },
  { id: 'sh-lerna-ls', name: 'lerna ls', description: 'List Lerna packages', emoji: '📦', command: 'npx lerna ls', cliType: 'shell', category: 'dev', tags: ['lerna', 'monorepo'] },

  // ═══════════════════════════════════════
  // ██  웹 개발 (Web Dev)
  // ═══════════════════════════════════════
  { id: 'sh-vite-dev', name: 'vite dev', description: 'Vite dev server', emoji: '⚡', command: 'npx vite', cliType: 'shell', category: 'frontend', tags: ['vite', 'dev'] },
  { id: 'sh-vite-build', name: 'vite build', description: 'Vite production build', emoji: '⚡', command: 'npx vite build', cliType: 'shell', category: 'frontend', tags: ['vite', 'build'] },
  { id: 'sh-vite-preview', name: 'vite preview', description: 'Vite build preview', emoji: '⚡', command: 'npx vite preview', cliType: 'shell', category: 'frontend', tags: ['vite'] },
  { id: 'sh-next-dev', name: 'next dev', description: 'Next.js dev server', emoji: '▲', command: 'npx next dev', cliType: 'shell', category: 'frontend', tags: ['next', 'react'] },
  { id: 'sh-next-build', name: 'next build', description: 'Next.js production build', emoji: '▲', command: 'npx next build', cliType: 'shell', category: 'frontend', tags: ['next', 'build'] },
  { id: 'sh-cra', name: 'create-react-app', description: 'Create React project', emoji: '⚛️', command: 'npx create-react-app', cliType: 'shell', category: 'react', tags: ['react', 'create'] },
  { id: 'sh-astro-dev', name: 'astro dev', description: 'Astro dev server', emoji: '🚀', command: 'npx astro dev', cliType: 'shell', category: 'frontend', tags: ['astro'] },
  { id: 'sh-nuxt-dev', name: 'nuxt dev', description: 'Nuxt dev server', emoji: '💚', command: 'npx nuxi dev', cliType: 'shell', category: 'frontend', tags: ['nuxt', 'vue'] },
  { id: 'sh-svelte-dev', name: 'svelte dev', description: 'SvelteKit dev server', emoji: '🔥', command: 'npx vite dev', cliType: 'shell', category: 'frontend', tags: ['svelte'] },
  { id: 'sh-tailwind-init', name: 'tailwind init', description: 'Initialize Tailwind CSS', emoji: '🎨', command: 'npx tailwindcss init', cliType: 'shell', category: 'frontend', tags: ['tailwind', 'css'] },
  { id: 'sh-storybook', name: 'storybook', description: 'Run Storybook', emoji: '📚', command: 'npx storybook dev', cliType: 'shell', category: 'frontend', tags: ['storybook', 'ui'] },
  { id: 'sh-playwright-test', name: 'playwright test', description: 'Playwright E2E tests', emoji: '🎭', command: 'npx playwright test', cliType: 'shell', category: 'testing', tags: ['playwright', 'e2e'] },
  { id: 'sh-cypress-run', name: 'cypress run', description: 'Cypress E2E tests', emoji: '🌲', command: 'npx cypress run', cliType: 'shell', category: 'testing', tags: ['cypress', 'e2e'] },
  { id: 'sh-lighthouse', name: 'lighthouse', description: 'Measure web performance', emoji: '🏠', command: 'npx lighthouse http://localhost:3000 --output html', cliType: 'shell', category: 'performance', tags: ['lighthouse'] },
  { id: 'sh-bundlesize', name: 'bundlephobia', description: 'Check bundle size', emoji: '📦', command: 'npx bundle-analyzer', cliType: 'shell', category: 'frontend', tags: ['bundle', 'size'] },
  { id: 'sh-serve', name: 'serve', description: 'Static file server', emoji: '🌐', command: 'npx serve', cliType: 'shell', category: 'frontend', tags: ['server', 'static'] },
  { id: 'sh-live-server', name: 'live-server', description: 'Live-reload server', emoji: '🌐', command: 'npx live-server', cliType: 'shell', category: 'frontend', tags: ['server', 'reload'] },
  { id: 'sh-webpack-build', name: 'webpack', description: 'Webpack build', emoji: '📦', command: 'npx webpack --mode production', cliType: 'shell', category: 'frontend', tags: ['webpack', 'build'] },
  { id: 'sh-esbuild', name: 'esbuild', description: 'Ultra-fast bundler', emoji: '⚡', command: 'npx esbuild --bundle', cliType: 'shell', category: 'frontend', tags: ['esbuild', 'bundle'] },

  // ═══════════════════════════════════════
  // ██  모바일 (Mobile)
  // ═══════════════════════════════════════
  { id: 'sh-expo-start', name: 'expo start', description: 'Expo dev server', emoji: '📱', command: 'npx expo start', cliType: 'shell', category: 'mobile', tags: ['expo', 'react-native'] },
  { id: 'sh-rn-start', name: 'react-native start', description: 'React Native Metro', emoji: '📱', command: 'npx react-native start', cliType: 'shell', category: 'mobile', tags: ['react-native'] },
  { id: 'sh-rn-ios', name: 'react-native run-ios', description: 'Run iOS simulator', emoji: '🍎', command: 'npx react-native run-ios', cliType: 'shell', category: 'mobile', tags: ['react-native', 'ios'] },
  { id: 'sh-rn-android', name: 'react-native run-android', description: 'Run Android emulator', emoji: '🤖', command: 'npx react-native run-android', cliType: 'shell', category: 'mobile', tags: ['react-native', 'android'] },
  { id: 'sh-flutter-run', name: 'flutter run', description: 'Run Flutter app', emoji: '🦋', command: 'flutter run', cliType: 'shell', category: 'mobile', tags: ['flutter', 'dart'] },
  { id: 'sh-flutter-build', name: 'flutter build', description: 'Flutter build', emoji: '🦋', command: 'flutter build', cliType: 'shell', category: 'mobile', tags: ['flutter'] },
  { id: 'sh-flutter-doctor', name: 'flutter doctor', description: 'Check Flutter environment', emoji: '🩺', command: 'flutter doctor', cliType: 'shell', category: 'mobile', tags: ['flutter'] },
  { id: 'sh-adb-devices', name: 'adb devices', description: 'List Android devices', emoji: '🤖', command: 'adb devices', cliType: 'shell', category: 'mobile', tags: ['android', 'adb'] },
  { id: 'sh-adb-logcat', name: 'adb logcat', description: 'Android logs', emoji: '🤖', command: 'adb logcat', cliType: 'shell', category: 'mobile', tags: ['android', 'log'] },
  { id: 'sh-adb-install', name: 'adb install', description: 'Install APK', emoji: '🤖', command: 'adb install', cliType: 'shell', category: 'mobile', tags: ['android', 'install'] },
  { id: 'sh-xcrun-simctl', name: 'xcrun simctl', description: 'Manage iOS simulators', emoji: '🍎', command: 'xcrun simctl list devices', cliType: 'shell', category: 'mobile', tags: ['ios', 'simulator'] },
  { id: 'sh-xcodebuild', name: 'xcodebuild', description: 'Xcode build (CLI)', emoji: '🍎', command: 'xcodebuild -workspace *.xcworkspace -scheme * build', cliType: 'shell', category: 'mobile', tags: ['ios', 'xcode'] },
  { id: 'sh-pod-install', name: 'pod install', description: 'Install CocoaPods dependencies', emoji: '🍎', command: 'cd ios && pod install', cliType: 'shell', category: 'mobile', tags: ['cocoapods', 'ios'] },
  { id: 'sh-tauri-dev', name: 'tauri dev', description: 'Tauri dev server', emoji: '🦀', command: 'npm run tauri dev', cliType: 'shell', category: 'dev', tags: ['tauri', 'desktop'] },
  { id: 'sh-tauri-build', name: 'tauri build', description: 'Tauri production build', emoji: '🦀', command: 'npm run tauri build', cliType: 'shell', category: 'dev', tags: ['tauri', 'desktop'] },
  { id: 'sh-electron-start', name: 'electron start', description: 'Run Electron app', emoji: '⚡', command: 'npx electron .', cliType: 'shell', category: 'dev', tags: ['electron', 'desktop'] },

  // ═══════════════════════════════════════
  // ██  API 테스트 (API Testing)
  // ═══════════════════════════════════════
  { id: 'sh-httpie-get', name: 'http GET', description: 'HTTPie GET request', emoji: '🌐', command: 'http GET', cliType: 'shell', category: 'network', tags: ['httpie', 'api'] },
  { id: 'sh-httpie-post', name: 'http POST', description: 'HTTPie POST request', emoji: '🌐', command: 'http POST', cliType: 'shell', category: 'network', tags: ['httpie', 'api'] },
  { id: 'sh-grpcurl', name: 'grpcurl', description: 'Test gRPC requests', emoji: '🌐', command: 'grpcurl -plaintext localhost:50051 list', cliType: 'shell', category: 'network', tags: ['grpc', 'api'] },
  { id: 'sh-websocat', name: 'websocat', description: 'Test WebSocket connection', emoji: '🔌', command: 'websocat ws://localhost:8080', cliType: 'shell', category: 'network', tags: ['websocket'] },
  { id: 'sh-ab', name: 'ab (ApacheBench)', description: 'HTTP load test', emoji: '⚡', command: 'ab -n 1000 -c 10', cliType: 'shell', category: 'network', tags: ['benchmark', 'load'] },
  { id: 'sh-wrk', name: 'wrk', description: 'HTTP benchmark', emoji: '⚡', command: 'wrk -t4 -c100 -d10s', cliType: 'shell', category: 'network', tags: ['benchmark'] },
  { id: 'sh-hey', name: 'hey', description: 'HTTP load test (Go)', emoji: '⚡', command: 'hey -n 1000 -c 50', cliType: 'shell', category: 'network', tags: ['benchmark'] },
  { id: 'sh-vegeta', name: 'vegeta attack', description: 'HTTP load test (vegeta)', emoji: '⚡', command: 'echo "GET http://localhost:3000" | vegeta attack -duration=10s | vegeta report', cliType: 'shell', category: 'network', tags: ['benchmark'] },

  // ═══════════════════════════════════════
  // ██  모니터링 & 로깅
  // ═══════════════════════════════════════
  { id: 'sh-dmesg', name: 'dmesg', description: 'Kernel message log', emoji: '📋', command: 'dmesg | tail -30', cliType: 'shell', category: 'system', tags: ['kernel', 'log'] },
  { id: 'sh-syslog', name: 'syslog (macOS)', description: 'macOS system log', emoji: '📋', command: 'log show --predicate \'eventMessage contains "error"\' --last 1h', cliType: 'shell', category: 'system', tags: ['macos', 'log'] },
  { id: 'sh-sar', name: 'sar', description: 'System activity report', emoji: '📊', command: 'sar -u 1 5', cliType: 'shell', category: 'system', tags: ['monitor', 'cpu'] },
  { id: 'sh-vmstat', name: 'vmstat', description: 'Virtual memory statistics', emoji: '📊', command: 'vmstat 1 5', cliType: 'shell', category: 'system', tags: ['memory', 'stats'] },
  { id: 'sh-mpstat', name: 'mpstat', description: 'Per-CPU usage', emoji: '📊', command: 'mpstat -P ALL 1 5', cliType: 'shell', category: 'system', tags: ['cpu', 'stats'] },
  { id: 'sh-nmon', name: 'nmon', description: 'Interactive system monitor', emoji: '📈', command: 'nmon', cliType: 'shell', category: 'system', tags: ['monitor'] },
  { id: 'sh-glances', name: 'glances', description: 'Cross-platform monitor', emoji: '📈', command: 'glances', cliType: 'shell', category: 'system', tags: ['monitor'] },
  { id: 'sh-iftop', name: 'iftop', description: 'Network traffic monitor', emoji: '📊', command: 'sudo iftop', cliType: 'shell', category: 'network', tags: ['monitor', 'traffic'] },
  { id: 'sh-nethogs', name: 'nethogs', description: 'Per-process network usage', emoji: '📊', command: 'sudo nethogs', cliType: 'shell', category: 'network', tags: ['monitor', 'process'] },
  { id: 'sh-bandwhich', name: 'bandwhich', description: 'Network bandwidth monitor (Rust)', emoji: '📊', command: 'sudo bandwhich', cliType: 'shell', category: 'network', tags: ['monitor', 'modern'] },
  { id: 'sh-ctop', name: 'ctop', description: 'Docker container monitor', emoji: '🐳', command: 'ctop', cliType: 'shell', category: 'docker', tags: ['monitor'] },
  { id: 'sh-lazydocker', name: 'lazydocker', description: 'Docker TUI manager', emoji: '🐳', command: 'lazydocker', cliType: 'shell', category: 'docker', tags: ['tui'] },
  { id: 'sh-lazygit', name: 'lazygit', description: 'Git TUI manager', emoji: '🌳', command: 'lazygit', cliType: 'shell', category: 'git', tags: ['tui'] },
  { id: 'sh-tig', name: 'tig', description: 'Git log viewer (TUI)', emoji: '🌳', command: 'tig', cliType: 'shell', category: 'git', tags: ['tui', 'log'] },
  { id: 'sh-gitui', name: 'gitui', description: 'Git TUI (Rust)', emoji: '🌳', command: 'gitui', cliType: 'shell', category: 'git', tags: ['tui'] },
  { id: 'sh-k9s', name: 'k9s', description: 'Kubernetes TUI manager', emoji: '☸️', command: 'k9s', cliType: 'shell', category: 'k8s', tags: ['tui'] },

  // ═══════════════════════════════════════
  // ██  보안 & 암호화 추가
  // ═══════════════════════════════════════
  { id: 'sh-ssh-agent', name: 'ssh-agent', description: 'Start SSH agent', emoji: '🔑', command: 'eval "$(ssh-agent -s)" && ssh-add', cliType: 'shell', category: 'security', tags: ['ssh', 'agent'] },
  { id: 'sh-ssh-list-keys', name: 'ssh-add -l', description: 'List registered SSH keys', emoji: '🔑', command: 'ssh-add -l', cliType: 'shell', category: 'security', tags: ['ssh', 'key'] },
  { id: 'sh-openssl-enc', name: 'openssl encrypt', description: 'AES-256 file encryption', emoji: '🔐', command: 'openssl enc -aes-256-cbc -salt -in file -out file.enc', cliType: 'shell', category: 'security', tags: ['encrypt'] },
  { id: 'sh-openssl-dec', name: 'openssl decrypt', description: 'AES-256 file decryption', emoji: '🔐', command: 'openssl enc -d -aes-256-cbc -in file.enc -out file', cliType: 'shell', category: 'security', tags: ['decrypt'] },
  { id: 'sh-sshpass', name: 'sshpass', description: 'Auto-enter SSH password', emoji: '🔑', command: 'sshpass -p password ssh user@host', cliType: 'shell', category: 'security', tags: ['ssh'] },
  { id: 'sh-fail2ban', name: 'fail2ban-client', description: 'Check Fail2Ban status', emoji: '🛡️', command: 'sudo fail2ban-client status', cliType: 'shell', category: 'security', tags: ['firewall'] },
  { id: 'sh-ufw', name: 'ufw status', description: 'UFW firewall status', emoji: '🛡️', command: 'sudo ufw status verbose', cliType: 'shell', category: 'security', tags: ['firewall'] },
  { id: 'sh-certbot', name: 'certbot', description: 'Let\'s Encrypt SSL certificate', emoji: '🔐', command: 'sudo certbot --nginx', cliType: 'shell', category: 'security', tags: ['ssl', 'cert'] },
  { id: 'sh-trivy', name: 'trivy', description: 'Scan container vulnerabilities', emoji: '🛡️', command: 'trivy image', cliType: 'shell', category: 'security', tags: ['scan', 'docker'] },
  { id: 'sh-trufflehog', name: 'trufflehog', description: 'Scan Git secrets', emoji: '🐷', command: 'trufflehog git file://. --only-verified', cliType: 'shell', category: 'security', tags: ['secret', 'scan'] },
  { id: 'sh-gitleaks', name: 'gitleaks', description: 'Detect Git secret leaks', emoji: '🔍', command: 'gitleaks detect', cliType: 'shell', category: 'security', tags: ['secret', 'scan'] },

  // ═══════════════════════════════════════
  // ██  Nginx / Apache / 웹서버
  // ═══════════════════════════════════════
  { id: 'sh-nginx-test', name: 'nginx -t', description: 'Test Nginx config', emoji: '🌐', command: 'sudo nginx -t', cliType: 'shell', category: 'ops', tags: ['nginx'] },
  { id: 'sh-nginx-reload', name: 'nginx reload', description: 'Reload Nginx', emoji: '🌐', command: 'sudo nginx -s reload', cliType: 'shell', category: 'ops', tags: ['nginx'] },
  { id: 'sh-caddy-run', name: 'caddy run', description: 'Run Caddy web server', emoji: '🌐', command: 'caddy run', cliType: 'shell', category: 'ops', tags: ['caddy'] },
  { id: 'sh-caddy-reverse', name: 'caddy reverse-proxy', description: 'Caddy reverse proxy', emoji: '🌐', command: 'caddy reverse-proxy --from :80 --to :3000', cliType: 'shell', category: 'ops', tags: ['caddy', 'proxy'] },

  // ═══════════════════════════════════════
  // ██  쉘 스크립팅 헬퍼
  // ═══════════════════════════════════════
  { id: 'sh-shellcheck', name: 'shellcheck', description: 'Shell script lint', emoji: '✅', command: 'shellcheck', cliType: 'shell', category: 'dev', tags: ['lint', 'shell'] },
  { id: 'sh-shfmt', name: 'shfmt', description: 'Shell script formatting', emoji: '✨', command: 'shfmt -i 2 -w', cliType: 'shell', category: 'dev', tags: ['format', 'shell'] },
  { id: 'sh-chmod-script', name: 'chmod +x *.sh', description: 'Script execute permission', emoji: '🔐', command: 'chmod +x *.sh', cliType: 'shell', category: 'system', tags: ['permission', 'script'] },
  { id: 'sh-bash-debug', name: 'bash -x', description: 'Run script in debug mode', emoji: '🐛', command: 'bash -x', cliType: 'shell', category: 'dev', tags: ['debug', 'shell'] },
  { id: 'sh-set-e', name: 'set -euo pipefail', description: 'Enable strict mode', emoji: '🛡️', command: 'set -euo pipefail', cliType: 'shell', category: 'dev', tags: ['shell', 'strict'] },
  { id: 'sh-trap', name: 'trap', description: 'Set signal trap', emoji: '🪤', command: 'trap "echo cleanup" EXIT', cliType: 'shell', category: 'dev', tags: ['shell', 'signal'] },
  { id: 'sh-read', name: 'read', description: 'Read user input', emoji: '⌨️', command: 'read -p "Enter: " input', cliType: 'shell', category: 'system', tags: ['input'] },
  { id: 'sh-select', name: 'select', description: 'Menu selection', emoji: '📋', command: 'select opt in a b c; do echo $opt; break; done', cliType: 'shell', category: 'system', tags: ['menu'] },
  { id: 'sh-getopts', name: 'getopts', description: 'Parse command-line options', emoji: '⚙️', command: 'while getopts "a:b:" opt; do case $opt in a) echo $OPTARG;; esac; done', cliType: 'shell', category: 'dev', tags: ['shell', 'args'] },
  { id: 'sh-mktemp', name: 'mktemp', description: 'Create temp file/directory', emoji: '📝', command: 'mktemp -d', cliType: 'shell', category: 'system', tags: ['temp'] },

  // ═══════════════════════════════════════
  // ██  추가 실용 명령어
  // ═══════════════════════════════════════
  { id: 'sh-parallel', name: 'parallel', description: 'GNU parallel execution', emoji: '⚡', command: 'parallel', cliType: 'shell', category: 'system', tags: ['parallel'] },
  { id: 'sh-entr', name: 'entr', description: 'Auto-run on file change', emoji: '👁️', command: 'ls *.ts | entr -r npm test', cliType: 'shell', category: 'dev', tags: ['watch', 'auto'] },
  { id: 'sh-fswatch', name: 'fswatch', description: 'Watch filesystem changes', emoji: '👁️', command: 'fswatch .', cliType: 'shell', category: 'system', tags: ['watch'] },
  { id: 'sh-inotifywait', name: 'inotifywait', description: 'Watch file events (Linux)', emoji: '👁️', command: 'inotifywait -m -r .', cliType: 'shell', category: 'system', tags: ['watch', 'linux'] },
  { id: 'sh-direnv', name: 'direnv allow', description: 'Per-directory environment variables', emoji: '🌍', command: 'direnv allow', cliType: 'shell', category: 'dev', tags: ['env'] },
  { id: 'sh-dotenv', name: 'dotenv', description: 'Load .env file and run command', emoji: '🌍', command: 'dotenv -- command', cliType: 'shell', category: 'dev', tags: ['env'] },
  { id: 'sh-jnv', name: 'jnv', description: 'Interactive JSON viewer', emoji: '🔧', command: 'jnv', cliType: 'shell', category: 'dev', tags: ['json', 'tui'] },
  { id: 'sh-fx', name: 'fx', description: 'JSON terminal viewer', emoji: '🔧', command: 'fx', cliType: 'shell', category: 'dev', tags: ['json', 'viewer'] },
  { id: 'sh-gron', name: 'gron', description: 'Make JSON greppable', emoji: '🔧', command: 'gron', cliType: 'shell', category: 'dev', tags: ['json', 'grep'] },
  { id: 'sh-xsv', name: 'xsv', description: 'Fast CSV processing (Rust)', emoji: '📊', command: 'xsv', cliType: 'shell', category: 'dev', tags: ['csv', 'fast'] },
  { id: 'sh-miller', name: 'mlr', description: 'CSV/JSON/TSV processing (Miller)', emoji: '📊', command: 'mlr --csv', cliType: 'shell', category: 'dev', tags: ['csv', 'json'] },
  { id: 'sh-age-enc', name: 'age (encrypt)', description: 'Simple file encryption', emoji: '🔐', command: 'age -p -o encrypted.age', cliType: 'shell', category: 'security', tags: ['encrypt', 'age'] },
  { id: 'sh-age-dec', name: 'age (decrypt)', description: 'Simple file decryption', emoji: '🔐', command: 'age -d -o decrypted encrypted.age', cliType: 'shell', category: 'security', tags: ['decrypt', 'age'] },
  { id: 'sh-mkcert', name: 'mkcert', description: 'Generate local HTTPS certificate', emoji: '🔐', command: 'mkcert localhost', cliType: 'shell', category: 'security', tags: ['ssl', 'local'] },
  { id: 'sh-pass', name: 'pass', description: 'Password manager (CLI)', emoji: '🔑', command: 'pass', cliType: 'shell', category: 'security', tags: ['password'] },
  { id: 'sh-task', name: 'task', description: 'Run Taskfile (Go Task)', emoji: '📋', command: 'task', cliType: 'shell', category: 'dev', tags: ['task', 'make'] },
  { id: 'sh-just', name: 'just', description: 'Run Justfile (command runner)', emoji: '📋', command: 'just', cliType: 'shell', category: 'dev', tags: ['just', 'make'] },
  { id: 'sh-chezmoi', name: 'chezmoi', description: 'Manage dotfiles', emoji: '🏠', command: 'chezmoi diff', cliType: 'shell', category: 'system', tags: ['dotfile'] },
  { id: 'sh-stow', name: 'stow', description: 'GNU Stow dotfile symlinks', emoji: '🏠', command: 'stow', cliType: 'shell', category: 'system', tags: ['dotfile', 'symlink'] },
  { id: 'sh-zoxide', name: 'z (zoxide)', description: 'Smart directory jump', emoji: '🚀', command: 'z', cliType: 'shell', category: 'system', tags: ['cd', 'smart'] },
  { id: 'sh-atuin', name: 'atuin', description: 'Sync shell history', emoji: '📜', command: 'atuin search', cliType: 'shell', category: 'system', tags: ['history', 'search'] },
  { id: 'sh-starship', name: 'starship', description: 'Cross-shell prompt', emoji: '🚀', command: 'starship init zsh', cliType: 'shell', category: 'system', tags: ['prompt'] },
  { id: 'sh-thefuck', name: 'fuck', description: 'Auto-correct previous command', emoji: '🤬', command: 'fuck', cliType: 'shell', category: 'system', tags: ['fix', 'auto'] },
  { id: 'sh-tlrc', name: 'tlrc', description: 'tldr Rust client', emoji: '📘', command: 'tldr', cliType: 'shell', category: 'system', tags: ['help', 'modern'] },
  { id: 'sh-cheat', name: 'cheat', description: 'View cheatsheet', emoji: '📘', command: 'cheat', cliType: 'shell', category: 'system', tags: ['help', 'cheat'] },
  { id: 'sh-navi', name: 'navi', description: 'Interactive cheatsheet', emoji: '📘', command: 'navi', cliType: 'shell', category: 'system', tags: ['help', 'interactive'] },
  { id: 'sh-broot', name: 'broot', description: 'Interactive tree viewer', emoji: '🌲', command: 'broot', cliType: 'shell', category: 'system', tags: ['tree', 'tui'] },
  { id: 'sh-xh', name: 'xh', description: 'HTTPie Rust alternative', emoji: '🌐', command: 'xh', cliType: 'shell', category: 'network', tags: ['http', 'modern'] },
  { id: 'sh-dog', name: 'dog', description: 'dig alternative (Rust)', emoji: '🐕', command: 'dog', cliType: 'shell', category: 'network', tags: ['dns', 'modern'] },
  { id: 'sh-gping', name: 'gping', description: 'ping graph', emoji: '📈', command: 'gping', cliType: 'shell', category: 'network', tags: ['ping', 'graph'] },
  { id: 'sh-curlie', name: 'curlie', description: 'curl + HTTPie hybrid', emoji: '🌐', command: 'curlie', cliType: 'shell', category: 'network', tags: ['http', 'modern'] },
  { id: 'sh-delta', name: 'delta', description: 'git diff viewer (syntax highlighting)', emoji: '🔀', command: 'delta', cliType: 'shell', category: 'git', tags: ['diff', 'modern'] },
  { id: 'sh-difftastic', name: 'difft', description: 'Structure-aware diff', emoji: '🔀', command: 'difft', cliType: 'shell', category: 'git', tags: ['diff', 'ast'] },
  { id: 'sh-sd', name: 'sd', description: 'sed alternative (intuitive)', emoji: '✏️', command: 'sd "old" "new"', cliType: 'shell', category: 'system', tags: ['replace', 'modern'] },
  { id: 'sh-choose', name: 'choose', description: 'cut alternative (intuitive)', emoji: '✂️', command: 'choose 0 2', cliType: 'shell', category: 'system', tags: ['column', 'modern'] },
  { id: 'sh-bottom', name: 'btm', description: 'top alternative (Rust)', emoji: '📈', command: 'btm', cliType: 'shell', category: 'system', tags: ['monitor', 'modern'] },
  { id: 'sh-duf', name: 'duf', description: 'df alternative (Go)', emoji: '💾', command: 'duf', cliType: 'shell', category: 'system', tags: ['disk', 'modern'] },
  { id: 'sh-gdu', name: 'gdu', description: 'du alternative (Go)', emoji: '💾', command: 'gdu', cliType: 'shell', category: 'system', tags: ['disk', 'modern'] },
  { id: 'sh-viddy', name: 'viddy', description: 'watch alternative (diff highlight)', emoji: '👁️', command: 'viddy', cliType: 'shell', category: 'system', tags: ['watch', 'modern'] },
  { id: 'sh-zellij', name: 'zellij', description: 'tmux alternative (Rust)', emoji: '🖥️', command: 'zellij', cliType: 'shell', category: 'system', tags: ['tmux', 'modern'] },
  { id: 'sh-wezterm', name: 'wezterm', description: 'WezTerm CLI', emoji: '🖥️', command: 'wezterm cli', cliType: 'shell', category: 'system', tags: ['terminal'] },
  { id: 'sh-lsd', name: 'lsd', description: 'ls alternative (icons, color)', emoji: '📂', command: 'lsd -la', cliType: 'shell', category: 'system', tags: ['ls', 'modern'] },
  { id: 'sh-vivid', name: 'vivid', description: 'Generate LS_COLORS theme', emoji: '🎨', command: 'vivid generate', cliType: 'shell', category: 'system', tags: ['color', 'theme'] },
  { id: 'sh-tokei2', name: 'scc', description: 'Ultra-fast lines-of-code counter', emoji: '📊', command: 'scc', cliType: 'shell', category: 'dev', tags: ['stats', 'fast'] },
  { id: 'sh-typos', name: 'typos', description: 'Find typos in code', emoji: '🔍', command: 'typos', cliType: 'shell', category: 'dev', tags: ['typo', 'lint'] },
  { id: 'sh-ast-grep', name: 'ast-grep', description: 'AST-based code search/rewrite', emoji: '🔍', command: 'ast-grep', cliType: 'shell', category: 'dev', tags: ['search', 'ast'] },
  { id: 'sh-mise-run', name: 'mise run', description: 'Run mise task', emoji: '📦', command: 'mise run', cliType: 'shell', category: 'dev', tags: ['mise', 'task'] },
  { id: 'sh-pv', name: 'pv', description: 'Show pipe progress', emoji: '📊', command: 'pv', cliType: 'shell', category: 'system', tags: ['progress', 'pipe'] },
  { id: 'sh-pigz', name: 'pigz', description: 'Parallel gzip', emoji: '🗜️', command: 'pigz', cliType: 'shell', category: 'system', tags: ['compress', 'parallel'] },
  { id: 'sh-pbzip2', name: 'pbzip2', description: 'Parallel bzip2', emoji: '🗜️', command: 'pbzip2', cliType: 'shell', category: 'system', tags: ['compress', 'parallel'] },
  { id: 'sh-zstd', name: 'zstd', description: 'Zstandard compression (Facebook)', emoji: '🗜️', command: 'zstd', cliType: 'shell', category: 'system', tags: ['compress', 'fast'] },
  { id: 'sh-lz4', name: 'lz4', description: 'LZ4 ultra-fast compression', emoji: '🗜️', command: 'lz4', cliType: 'shell', category: 'system', tags: ['compress', 'fast'] },
  { id: 'sh-mosh', name: 'mosh', description: 'SSH alternative (roaming support)', emoji: '🔒', command: 'mosh user@host', cliType: 'shell', category: 'network', tags: ['ssh', 'mobile'] },
  { id: 'sh-croc', name: 'croc', description: 'Easy P2P file transfer', emoji: '🐊', command: 'croc send', cliType: 'shell', category: 'network', tags: ['transfer', 'p2p'] },
  { id: 'sh-magic-wormhole', name: 'wormhole send', description: 'Magic Wormhole file transfer', emoji: '🕳️', command: 'wormhole send', cliType: 'shell', category: 'network', tags: ['transfer'] },
  { id: 'sh-rclone', name: 'rclone', description: 'Sync cloud storage', emoji: '☁️', command: 'rclone sync', cliType: 'shell', category: 'cloud', tags: ['sync', 'storage'] },
  { id: 'sh-restic', name: 'restic', description: 'Incremental backup (encrypted)', emoji: '💾', command: 'restic backup', cliType: 'shell', category: 'ops', tags: ['backup'] },
  { id: 'sh-borgbackup', name: 'borg', description: 'Deduplicating backup', emoji: '💾', command: 'borg create', cliType: 'shell', category: 'ops', tags: ['backup'] },
  { id: 'sh-asciinema', name: 'asciinema rec', description: 'Record terminal', emoji: '📹', command: 'asciinema rec', cliType: 'shell', category: 'dev', tags: ['record', 'terminal'] },
  { id: 'sh-vhs', name: 'vhs', description: 'Create terminal GIF', emoji: '📹', command: 'vhs', cliType: 'shell', category: 'dev', tags: ['record', 'gif'] },
  { id: 'sh-glow', name: 'glow', description: 'Terminal Markdown renderer', emoji: '📖', command: 'glow', cliType: 'shell', category: 'dev', tags: ['markdown', 'render'] },
  { id: 'sh-mdcat', name: 'mdcat', description: 'Markdown terminal viewer', emoji: '📖', command: 'mdcat', cliType: 'shell', category: 'dev', tags: ['markdown'] },
  { id: 'sh-slides', name: 'slides', description: 'Terminal presentation', emoji: '🎬', command: 'slides', cliType: 'shell', category: 'dev', tags: ['presentation'] },
  { id: 'sh-charm', name: 'charm', description: 'Charm Cloud account', emoji: '✨', command: 'charm', cliType: 'shell', category: 'dev', tags: ['charm'] },
  { id: 'sh-gum', name: 'gum', description: 'Shell script UI tool', emoji: '🫧', command: 'gum choose "a" "b" "c"', cliType: 'shell', category: 'dev', tags: ['tui', 'shell'] },
  { id: 'sh-pueue', name: 'pueue', description: 'Task queue manager', emoji: '📋', command: 'pueue status', cliType: 'shell', category: 'system', tags: ['queue', 'task'] },
  { id: 'sh-procs2', name: 'procs --tree', description: 'Process tree (Rust)', emoji: '🌲', command: 'procs --tree', cliType: 'shell', category: 'system', tags: ['process', 'tree'] },
  { id: 'sh-oha', name: 'oha', description: 'HTTP load test (Rust)', emoji: '⚡', command: 'oha', cliType: 'shell', category: 'network', tags: ['benchmark', 'modern'] },
  { id: 'sh-miniserve', name: 'miniserve', description: 'Mini HTTP server (Rust)', emoji: '🌐', command: 'miniserve .', cliType: 'shell', category: 'dev', tags: ['server', 'rust'] },
  { id: 'sh-bore', name: 'bore', description: 'ngrok alternative (Rust)', emoji: '🌍', command: 'bore local 3000', cliType: 'shell', category: 'dev', tags: ['tunnel'] },
  { id: 'sh-cloudflared', name: 'cloudflared tunnel', description: 'Cloudflare tunnel', emoji: '☁️', command: 'cloudflared tunnel', cliType: 'shell', category: 'network', tags: ['tunnel', 'cloudflare'] },
  { id: 'sh-dog-dns', name: 'doggo', description: 'DNS lookup (Go)', emoji: '🐶', command: 'doggo', cliType: 'shell', category: 'network', tags: ['dns', 'modern'] },
  { id: 'sh-trippy', name: 'trippy', description: 'traceroute TUI (Rust)', emoji: '🗺️', command: 'trip', cliType: 'shell', category: 'network', tags: ['traceroute', 'modern'] },
  { id: 'sh-termscp', name: 'termscp', description: 'SCP/SFTP TUI', emoji: '📤', command: 'termscp', cliType: 'shell', category: 'network', tags: ['scp', 'tui'] },
  { id: 'sh-yazi', name: 'yazi', description: 'Terminal file manager (Rust)', emoji: '📂', command: 'yazi', cliType: 'shell', category: 'system', tags: ['file-manager', 'tui'] },
  { id: 'sh-nnn', name: 'nnn', description: 'Terminal file manager', emoji: '📂', command: 'nnn', cliType: 'shell', category: 'system', tags: ['file-manager', 'tui'] },
  { id: 'sh-lf', name: 'lf', description: 'Terminal file manager (Go)', emoji: '📂', command: 'lf', cliType: 'shell', category: 'system', tags: ['file-manager', 'tui'] },
  { id: 'sh-ranger', name: 'ranger', description: 'Terminal file manager (Python)', emoji: '📂', command: 'ranger', cliType: 'shell', category: 'system', tags: ['file-manager', 'tui'] },
  { id: 'sh-mc', name: 'mc', description: 'Midnight Commander', emoji: '📂', command: 'mc', cliType: 'shell', category: 'system', tags: ['file-manager'] },
  { id: 'sh-helix', name: 'hx', description: 'Helix editor', emoji: '✏️', command: 'hx', cliType: 'shell', category: 'dev', tags: ['editor'] },
  { id: 'sh-nvim', name: 'nvim', description: 'Neovim editor', emoji: '✏️', command: 'nvim', cliType: 'shell', category: 'dev', tags: ['editor'] },
  { id: 'sh-micro', name: 'micro', description: 'Micro editor (intuitive)', emoji: '✏️', command: 'micro', cliType: 'shell', category: 'dev', tags: ['editor'] },
  { id: 'sh-kakoune', name: 'kak', description: 'Kakoune editor', emoji: '✏️', command: 'kak', cliType: 'shell', category: 'dev', tags: ['editor'] },
  { id: 'sh-gpustat', name: 'gpustat', description: 'GPU usage monitor', emoji: '🎮', command: 'gpustat -i 1', cliType: 'shell', category: 'system', tags: ['gpu', 'monitor'] },
  { id: 'sh-nvidia-smi', name: 'nvidia-smi', description: 'NVIDIA GPU status', emoji: '🎮', command: 'nvidia-smi', cliType: 'shell', category: 'system', tags: ['gpu', 'nvidia'] },
  { id: 'sh-powermetrics', name: 'powermetrics', description: 'Apple Silicon power metrics', emoji: '🔋', command: 'sudo powermetrics --samplers cpu_power -i 1000 -n 5', cliType: 'shell', category: 'system', tags: ['macos', 'power'] },
  { id: 'sh-sysbench', name: 'sysbench', description: 'System benchmark', emoji: '⚡', command: 'sysbench cpu --threads=4 run', cliType: 'shell', category: 'system', tags: ['benchmark'] },
  { id: 'sh-stress', name: 'stress', description: 'CPU/memory stress test', emoji: '🔥', command: 'stress --cpu 4 --timeout 10s', cliType: 'shell', category: 'system', tags: ['stress', 'test'] },
  { id: 'sh-hexyl', name: 'hexyl', description: 'Hex viewer (Rust)', emoji: '🔢', command: 'hexyl', cliType: 'shell', category: 'dev', tags: ['hex', 'viewer'] },
  { id: 'sh-xxd', name: 'xxd', description: 'Hex dump', emoji: '🔢', command: 'xxd', cliType: 'shell', category: 'dev', tags: ['hex'] },
  { id: 'sh-strings', name: 'strings', description: 'Extract strings from a binary', emoji: '🔍', command: 'strings', cliType: 'shell', category: 'dev', tags: ['binary', 'extract'] },
  { id: 'sh-nm', name: 'nm', description: 'List object file symbols', emoji: '🔍', command: 'nm', cliType: 'shell', category: 'dev', tags: ['binary', 'symbol'] },
  { id: 'sh-otool', name: 'otool', description: 'Analyze Mach-O file (macOS)', emoji: '🔍', command: 'otool -L', cliType: 'shell', category: 'dev', tags: ['macos', 'binary'] },
  { id: 'sh-ldd', name: 'ldd', description: 'Shared library dependencies', emoji: '🔍', command: 'ldd', cliType: 'shell', category: 'dev', tags: ['linux', 'library'] },
  { id: 'sh-objdump', name: 'objdump', description: 'Disassemble object file', emoji: '🔍', command: 'objdump -d', cliType: 'shell', category: 'dev', tags: ['binary', 'asm'] },
];

