const express = require('express');
const cors = require('cors');
const simpleGit = require('simple-git');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(cors({
  origin:['https://nxzen.blackbucks.me/']
}));
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

// Clone repository
app.post('/api/clone', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'Repository URL is required' });
  }

  try {
    // Clean up existing repo if any
    if (fs.existsSync(REPO_DIR)) {
      await fs.remove(REPO_DIR);
      git = null;
    }

    console.log('Cloning repository...');
    await simpleGit().clone(url, REPO_DIR, ['--depth', '50']); // Shallow clone for faster cloning
    initGit();
    
    console.log('Repository cloned successfully');
    res.json({ message: 'Repository Fetched successfully' });
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
          commitHashes: [],
          commitMessages: [] // { hash, message, date }
        });
      }

      const contributor = contributorMap.get(username);
      contributor.commits++;
      contributor.commitHashes.push(commit.hash);
      // Store commit message metadata for display
      contributor.commitMessages.push({
        hash: commit.hash,
        message: commit.message.split('\n')[0],
        date: commit.date
      });

      try {
        // Get commit stats with timeout protection
        const show = await Promise.race([
          git.show(['--stat', '--format=', '-p', commit.hash]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), 5000)
          )
        ]);
        
        const lines = show.split('\n');
        
        // Track contributor totals and build a per-commit summary
        let filesChanged = 0;
        let ins = 0;
        let del = 0;
        const fileChanges = [];
        
        for (const line of lines) {
          // Parse summary line
          const summaryMatch = line.match(/(\d+) files? changed(?:,\s*(\d+) insertions?\(\+\))?(?:,\s*(\d+) deletions?\(-\))?/);
          if (summaryMatch) {
            filesChanged = parseInt(summaryMatch[1]) || filesChanged;
            if (summaryMatch[2]) ins = parseInt(summaryMatch[2]) || ins;
            if (summaryMatch[3]) del = parseInt(summaryMatch[3]) || del;
          }
          
          // Parse per-file change counts from the --stat table
          const fileLineMatch = line.match(/^\s*(.+?)\s+\|\s+(\d+)/);
          if (fileLineMatch) {
            fileChanges.push({ file: fileLineMatch[1].trim(), changes: parseInt(fileLineMatch[2]) || 0 });
          }
          
          // Maintain contributor totals (fallback if summary not present)
          const insDelMatch = line.match(/(\d+) insertion.*?(\d+) deletion/);
          if (insDelMatch) {
            contributor.additions += parseInt(insDelMatch[1]) || 0;
            contributor.deletions += parseInt(insDelMatch[2]) || 0;
          } else if (line.includes('insertion')) {
            const addMatch = line.match(/(\d+) insertion/);
            if (addMatch) contributor.additions += parseInt(addMatch[1]) || 0;
          } else if (line.includes('deletion')) {
            const delMatch = line.match(/(\d+) deletion/);
            if (delMatch) contributor.deletions += parseInt(delMatch[1]) || 0;
          }
        }
        
        // If we parsed explicit ins/del from summary, also add to contributor totals (avoid double-counting if already added above)
        if (ins || del) {
          // Heuristic: only add when above loop didn't already add via combined summary (to avoid duplicates)
          // We can't perfectly detect, so only add if contributor totals for this commit didn't change in the loop due to summary
          // To keep it simple and safe, do nothing here; contributor totals were already updated from the lines above.
        }
        
        // Attach a compact per-commit summary to the last message entry
        const lastMsg = contributor.commitMessages[contributor.commitMessages.length - 1];
        if (lastMsg) {
          const topFiles = fileChanges
            .sort((a, b) => b.changes - a.changes)
            .slice(0, 3)
            .map(fc => fc.file);
          const textParts = [];
          if (filesChanged) textParts.push(`${filesChanged} files changed`);
          if (ins) textParts.push(`+${ins}`);
          if (del) textParts.push(`−${del}`);
          lastMsg.summary = {
            text: textParts.join(', '),
            filesChanged: filesChanged || fileChanges.length || 0,
            insertions: ins || 0,
            deletions: del || 0,
            topFiles
          };
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
            '--format=medium',
            '--unified=3', // Show 3 lines of context
            '--stat',
            '--numstat',
            '--name-status',
            '-p',
            commit.hash
          ]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Diff fetch timeout')), 10000)
          )
        ]);

        // Parse the diff output
        const lines = diffResult.split('\n');
        
        // Build a summary from --stat/--numstat/--name-status sections
        let filesChanged = 0;
        let ins = 0;
        let del = 0;
        const fileChanges = [];
        const numstatMap = new Map(); // file -> {insertions, deletions, binary}
        const addedFiles = [];
        const modifiedFiles = [];
        const deletedFiles = [];
        const renamedFiles = []; // {from, to}
        for (const line of lines) {
          // Overall summary line from --stat
          const summaryMatch = line.match(/(\d+) files? changed(?:,\s*(\d+) insertions?\(\+\))?(?:,\s*(\d+) deletions?\(-\))?/);
          if (summaryMatch) {
            filesChanged = parseInt(summaryMatch[1]) || filesChanged;
            if (summaryMatch[2]) ins = parseInt(summaryMatch[2]) || ins;
            if (summaryMatch[3]) del = parseInt(summaryMatch[3]) || del;
          }
          // Per-file summary line from --stat table
          const fileLineMatch = line.match(/^\s*(.+?)\s+\|\s+(\d+)/);
          if (fileLineMatch) {
            fileChanges.push({ file: fileLineMatch[1].trim(), changes: parseInt(fileLineMatch[2]) || 0 });
          }
          // --numstat lines: <ins>\t<del>\t<path> ("-" means binary)
          const numstatMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
          if (numstatMatch) {
            const i = numstatMatch[1] === '-' ? 0 : parseInt(numstatMatch[1]) || 0;
            const d = numstatMatch[2] === '-' ? 0 : parseInt(numstatMatch[2]) || 0;
            const f = numstatMatch[3].trim();
            numstatMap.set(f, { insertions: i, deletions: d, binary: numstatMatch[1] === '-' || numstatMatch[2] === '-' });
          }
          // --name-status lines: A|M|D|R<score> \t paths
          // Rename: R100\told\tnew or R\told\tnew
          const renameMatch = line.match(/^R\d*\t(.+)\t(.+)$/);
          if (renameMatch) {
            renamedFiles.push({ from: renameMatch[1].trim(), to: renameMatch[2].trim() });
            continue;
          }
          const nsMatch = line.match(/^([AMDC])\t(.+)$/);
          if (nsMatch) {
            const status = nsMatch[1];
            const file = nsMatch[2].trim();
            if (status === 'A') addedFiles.push(file);
            else if (status === 'M') modifiedFiles.push(file);
            else if (status === 'D') deletedFiles.push(file);
            // 'C' (copy) treat as added
            else if (status === 'C') addedFiles.push(file);
          }
        }
        // Build files detail combining name-status and numstat
        const detailFiles = [];
        const pushDetail = (file, kind) => {
          const ns = numstatMap.get(file) || { insertions: 0, deletions: 0, binary: false };
          detailFiles.push({ file, status: kind, insertions: ns.insertions, deletions: ns.deletions, binary: !!ns.binary });
        };
        addedFiles.forEach(f => pushDetail(f, 'A'));
        modifiedFiles.forEach(f => pushDetail(f, 'M'));
        deletedFiles.forEach(f => pushDetail(f, 'D'));
        renamedFiles.forEach(({from, to}) => {
          const ns = numstatMap.get(to) || numstatMap.get(from) || { insertions: 0, deletions: 0, binary: false };
          detailFiles.push({ file: to, status: 'R', from, to, insertions: ns.insertions, deletions: ns.deletions, binary: !!ns.binary });
        });
        // Aggregate by extension
        const byExtension = {};
        for (const df of detailFiles) {
          const ext = (df.file.split('/').pop() || '').split('.').slice(1).join('.') || 'noext';
          if (!byExtension[ext]) byExtension[ext] = { files: 0, insertions: 0, deletions: 0 };
          byExtension[ext].files += 1;
          byExtension[ext].insertions += df.insertions || 0;
          byExtension[ext].deletions += df.deletions || 0;
        }
        const summary = {
          text: [
            filesChanged ? `${filesChanged} files changed` : null,
            ins ? `+${ins}` : null,
            del ? `−${del}` : null
          ].filter(Boolean).join(', '),
          filesChanged: filesChanged || fileChanges.length || 0,
          insertions: ins || 0,
          deletions: del || 0,
          topFiles: fileChanges.sort((a,b)=>b.changes-a.changes).slice(0,3).map(x=>x.file),
          details: {
            counts: {
              addedFiles: addedFiles.length,
              modifiedFiles: modifiedFiles.length,
              deletedFiles: deletedFiles.length,
              renamedFiles: renamedFiles.length
            },
            files: detailFiles.sort((a,b)=> (b.insertions+b.deletions) - (a.insertions+a.deletions)),
            byExtension
          }
        };
        
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
          summary,
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
          summary: {
            text: `Error loading summary: ${err.message}`,
            filesChanged: 0,
            insertions: 0,
            deletions: 0,
            topFiles: []
          },
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

const PORT = 9000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  // Initialize git if repo already exists
  initGit();
});