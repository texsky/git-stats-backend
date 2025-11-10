const express = require('express');
const cors = require('cors');
const simpleGit = require('simple-git');
const fs = require('fs-extra');
const path = require('path');

const app = express();

// CORS: allow frontend to call this API and handle preflight
// Use an allowlist driven by env var; fall back to localhost and known prod domain.
const parseOrigins = (s) => (s || '').split(',').map(o => o.trim()).filter(Boolean);
const defaultAllowed = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://nxzen.blackbucks.me',
];
const allowedOrigins = parseOrigins(process.env.ALLOWED_ORIGINS).concat(defaultAllowed);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/server-to-server
    return cb(null, allowedOrigins.includes(origin));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  // Do not set allowedHeaders: cors will echo Access-Control-Request-Headers automatically
  optionsSuccessStatus: 204,
  // credentials: true, // enable only if sending cookies/auth from the browser
};
app.use(cors(corsOptions));
// Handle preflight for all routes (Express 5 compatible)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

const REPO_DIR = path.join(__dirname, 'cloned_repo');
let git = null;

// Initialize git instance only if repo exists
function initGit() {
  if (fs.existsSync(REPO_DIR)) {
    git = simpleGit(REPO_DIR, {
      timeout: {
        block: 60000 // 60 second timeout
      }
    });
    return true;
  }
  git = null;
  return false;
}

// Normalize and validate repository URL (prevent SSRF and common mistakes)
function normalizeRepoUrl(input) {
  // Allow SSH urls like git@github.com:user/repo.git as-is
  if (/^git@[^:]+:[^\s]+\.git$/i.test(input)) {
    return input;
  }

  // Only allow https clone from known hosts
  const allowedHosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new Error('Invalid URL. Use a full https Git URL, e.g., https://github.com/user/repo or https://github.com/user/repo.git');
  }

  if (!['https:'].includes(u.protocol)) {
    throw new Error('Only https clone URLs are allowed.');
  }
  if (!allowedHosts.has(u.hostname)) {
    throw new Error(`Host not allowed: ${u.hostname}. Allowed: github.com, gitlab.com, bitbucket.org`);
  }

  // Expect path like /owner/repo[.git][/...]
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error('URL must be of the form https://host/owner/repo');
  }
  const owner = parts[0];
  const repoRaw = parts[1];
  const repo = repoRaw.endsWith('.git') ? repoRaw.slice(0, -4) : repoRaw;
  u.pathname = `/${owner}/${repo}.git`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

// Clone repository
app.post('/api/clone', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'Repository URL is required' });
  }

  let normalizedUrl;
  try {
    normalizedUrl = normalizeRepoUrl(url);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid repository URL', details: e.message });
  }

  try {
    // Clean up existing repo if any
    if (fs.existsSync(REPO_DIR)) {
      await fs.remove(REPO_DIR);
      git = null;
    }

    console.log('Cloning repository...', normalizedUrl);
    await simpleGit().clone(normalizedUrl, REPO_DIR, ['--depth', '50']); // Shallow clone for faster cloning
    initGit();
    
    console.log('Repository cloned successfully');
    res.json({ message: 'Repository fetched successfully', normalizedUrl });
  } catch (error) {
    console.error('Clone error:', error);
    res.status(500).json({ error: 'Failed to clone repository', details: error.message });
  }
});

// Get contributors with their stats
app.get('/api/contributors', async (req, res) => {
  try {
    if (!initGit()) {
      return res.status(400).json({ error: 'No repository cloned yet' });
    }

    console.log('Fetching contributor stats...');
    const log = await git.log();
    const contributorMap = new Map();

    // Process each commit
    for (const commit of log.all) {
      const username = commit.author_name;
      
      if (!contributorMap.has(username)) {
        contributorMap.set(username, {
          username,
          commits: 0,
          additions: 0,
          deletions: 0,
          commitHashes: []
        });
      }

      const contributor = contributorMap.get(username);
      contributor.commits++;
      contributor.commitHashes.push(commit.hash);

      try {
        // Get commit stats with timeout protection
        const show = await Promise.race([
          git.show([commit.hash, '--stat', '--format=']),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), 5000)
          )
        ]);
        
        const lines = show.split('\n');
        
        for (const line of lines) {
          const match = line.match(/(\d+) insertion.*?(\d+) deletion/);
          if (match) {
            contributor.additions += parseInt(match[1]) || 0;
            contributor.deletions += parseInt(match[2]) || 0;
          } else if (line.includes('insertion')) {
            const addMatch = line.match(/(\d+) insertion/);
            if (addMatch) contributor.additions += parseInt(addMatch[1]) || 0;
          } else if (line.includes('deletion')) {
            const delMatch = line.match(/(\d+) deletion/);
            if (delMatch) contributor.deletions += parseInt(delMatch[1]) || 0;
          }
        }
      } catch (err) {
        console.warn(`Could not fetch stats for commit ${commit.hash}:`, err.message);
        // Continue processing other commits
      }
    }

    const contributors = Array.from(contributorMap.values())
      .sort((a, b) => b.commits - a.commits);

    console.log(`Found ${contributors.length} contributors`);
    res.json(contributors);
  } catch (error) {
    console.error('Error fetching contributors:', error);
    res.status(500).json({ error: 'Failed to fetch contributors', details: error.message });
  }
});

// Get code changes for a specific contributor
app.get('/api/contributor/:username/diffs', async (req, res) => {
  const { username } = req.params;

  try {
    if (!initGit()) {
      return res.status(400).json({ error: 'No repository cloned yet' });
    }

    console.log(`Fetching diffs for ${username}...`);
    const log = await git.log();
    const userCommits = log.all.filter(c => c.author_name === username);

    const diffs = [];
    
    // Limit to last 5 commits to avoid overwhelming the response
    const commitsToProcess = userCommits.slice(0, 5);

    for (const commit of commitsToProcess) {
      try {
        console.log(`Processing commit ${commit.hash}...`);
        
        // Get diff with limited context and timeout
        const diffResult = await Promise.race([
          git.show([
            commit.hash,
            '--format=medium',
            '--unified=3', // Show 3 lines of context
            '--stat',
            '--max-count=1'
          ]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Diff fetch timeout')), 10000)
          )
        ]);

        // Parse the diff output
        const lines = diffResult.split('\n');
        const changes = [];
        let inDiff = false;
        let lineCount = 0;
        const maxLines = 200; // Limit lines per commit

        for (const line of lines) {
          // Start capturing after the commit message
          if (line.startsWith('diff --git')) {
            inDiff = true;
          }
          
          if (inDiff && lineCount < maxLines) {
            // Only include meaningful diff lines
            if (line.startsWith('+') || line.startsWith('-') || 
                line.startsWith('@@') || line.startsWith('diff')) {
              changes.push(line);
              lineCount++;
            }
          }
        }

        if (changes.length === 0) {
          changes.push('// No code changes to display (possibly binary files or large changes)');
        } else if (lineCount >= maxLines) {
          changes.push('... (output truncated - too many changes)');
        }

        diffs.push({
          commit: commit.hash.substring(0, 7),
          message: commit.message.split('\n')[0], // First line only
          date: commit.date,
          changes: changes
        });

        console.log(`Processed commit ${commit.hash.substring(0, 7)} with ${changes.length} change lines`);
        
      } catch (err) {
        console.error(`Error fetching diff for commit ${commit.hash}:`, err.message);
        
        // Add error info instead of failing completely
        diffs.push({
          commit: commit.hash.substring(0, 7),
          message: commit.message.split('\n')[0],
          date: commit.date,
          changes: [
            `// Error loading changes: ${err.message}`,
            '// This commit may have too many changes or contain binary files'
          ]
        });
      }
    }

    if (diffs.length === 0) {
      return res.json([{
        commit: 'N/A',
        message: 'No commits found for this user',
        date: new Date().toISOString(),
        changes: ['// No commits available']
      }]);
    }

    console.log(`Returning ${diffs.length} diffs for ${username}`);
    res.json(diffs);
    
  } catch (error) {
    console.error('Error fetching diffs:', error);
    res.status(500).json({ 
      error: 'Failed to fetch code changes', 
      details: error.message,
      suggestion: 'The repository may be too large or the commits contain many changes. Try with a smaller repository.'
    });
  }
});

// Delete cloned repository
app.delete('/api/delete', async (req, res) => {
  try {
    if (fs.existsSync(REPO_DIR)) {
      await fs.remove(REPO_DIR);
      git = null;
      console.log('Repository deleted successfully');
      res.json({ message: 'Repository deleted successfully' });
    } else {
      res.status(404).json({ error: 'No repository to delete' });
    }
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete repository', details: error.message });
  }
});

// Simple health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Root health for PaaS health checks
app.get('/', (req, res) => {
  res.send('OK');
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on port ${PORT}`);
  // Initialize git if repo already exists
  initGit();
});
