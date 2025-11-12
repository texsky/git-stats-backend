const express = require('express');
const cors = require('cors');
const simpleGit = require('simple-git');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config()

const app = express();
app.use(cors());
app.use(express.json());

// email
const nodemailer = require('nodemailer');
function buildTransport() {
  const { SMTP_USER, SMTP_PASS } = process.env;
  return nodemailer.createTransport({
    service:'gmail',
    secure:true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

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
    await simpleGit().clone(url, REPO_DIR); // Full clone to include all history
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
    
    // Process all commits for the user
    const commitsToProcess = userCommits;

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

        // Parse the diff output and drop node_modules files
        const lines = diffResult.split('\n');
        const fileBlocks = [];
        let current = null;

        for (const line of lines) {
          if (line.startsWith('diff --git ')) {
            if (current) fileBlocks.push(current);
            const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
            const aPath = match ? match[1] : '';
            const bPath = match ? match[2] : '';
            current = { aPath, bPath, lines: [line] };
          } else if (current) {
            current.lines.push(line);
          }
        }
        if (current) fileBlocks.push(current);

        // Filter out node_modules changes
        const filteredBlocks = fileBlocks.filter(b => {
          const aNM = b.aPath.includes('node_modules/');
          const bNM = b.bPath.includes('node_modules/');
          return !(aNM || bNM);
        });

        // If all changes are in node_modules, skip this commit entirely
        if (filteredBlocks.length === 0) {
          continue;
        }

        const changes = filteredBlocks.flatMap(b => b.lines);

        diffs.push({
          commit: commit.hash.substring(0, 7),
          message: commit.message.split('\n')[0], // First line only
          date: commit.date,
          changes
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

// Registration email endpoint
app.post('/api/registration-email', async (req, res) => {
  try {
    const { teamName, theme, members, submissionLink } = req.body || {};
    console.log('[mail] request', { teamName, theme, membersCount: Array.isArray(members) ? members.length : null, submissionLink });
    if (!teamName || !theme || !Array.isArray(members)) {
      console.error('[mail] missing required fields');
      return res.status(400).json({ error: 'Missing fields teamName/theme/members' });
    }
    const transport = buildTransport();
    if (!transport) {
      console.warn('[mail] transport not configured; skipping send');
      return res.json({ status: 'skipped', reason: 'transport not configured' });
    }

    const toListArr = members.map(m => m && m.email).filter(Boolean);
    const toList = toListArr.join(',');
    console.log('[mail] recipients', toListArr);
    const subject = `Hackathon Submission Instructions — ${theme}`;

    const contactEmail = 'contact@blackbucks.me';
    const organization = 'BlackBucks Group';
    const submitURL = submissionLink || 'https://taptap.blackbucks.me/hackathon/results/5729/?testType=19';

    // verify SMTP
    try {
      const ok = await transport.verify();
      console.log('[mail] transport.verify:', ok === true ? true : ok);
    } catch (e) {
      console.error('[mail] transport verify failed:', e && e.message, e && e.code);
      return res.status(500).json({ error: 'SMTP verification failed', details: e.message, code: e.code });
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hackathon Submission Instructions</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; background-color: #f7f8fa; margin: 0; padding: 0; color: #333333; }
    .container { max-width: 700px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 40px; }
    h2 { color: #1a73e8; margin-bottom: 10px; }
    h3 { color: #333333; margin-top: 25px; }
    p { line-height: 1.6; }
    a { color: #1a73e8; text-decoration: none; }
    .button { display: inline-block; background-color: #1a73e8; color: #ffffff; padding: 12px 24px; border-radius: 5px; font-weight: 500; text-decoration: none; margin-top: 15px; }
    .footer { margin-top: 30px; font-size: 14px; color: #777777; border-top: 1px solid #eeeeee; padding-top: 15px; }
  </style>
</head>
<body>
  <div class="container">
    <img src="https://nxzen.blackbucks.me/src/assets/nxgen.jpeg" width="400px" height="180px"/>
    <h2>Nxzen Hackathon Submission Instructions</h2>
    <p>Dear <strong>${teamName}</strong>,</p>
    <p>
      Thank you for registering for the <strong>${theme}</strong>.
      We are excited to have your team participate and look forward to seeing your innovative project.
    </p>

    <h3>Step 1: Create Your Account</h3>
    <p>
      Each team member must create an account using the <strong>registered email ID</strong> at:<br>
      <a href="https://taptap.blackbucks.me/">https://taptap.blackbucks.me/</a><br>
      This step is mandatory to ensure your submission is properly linked to your registration.
    </p>

    <h3>Step 2: Prepare Your Submission</h3>
    <p>Your submission must include the following:</p>
    <ul>
      <li><strong>GitHub Repository Link</strong> containing your project source code.</li>
      <li><strong>ZIP File</strong> which includes:
        <ul>
          <li>Project Presentation (PPT or PDF)</li>
          <li>Documentation or Project Report</li>
          <li>Video Presentation (demo and explanation)</li>
        </ul>
      </li>
    </ul>

    <h3>Step 3: Submit Your Project</h3>
    <p>
      Once your materials are ready, please upload them using the link below.
    </p>
    <a href="${submitURL}" class="button">Submit Project</a>

    <p>
      If you have any questions or encounter any issues, please contact us at
      <a href="mailto:${contactEmail}">${contactEmail}</a>.
    </p>

    <p>We wish your team the very best and look forward to reviewing your submission.</p>

    <div class="footer">
      <p>
        Regards,<br>
        ${organization} in collab with Nxzen Global Limited<br>
        <a href="mailto:${contactEmail}">${contactEmail}</a>
      </p>
    </div>
  </div>
</body>
</html>`;

    const text = [
      `Hackathon Submission Instructions`,
      `Team: ${teamName}`,
      `Hackathon: ${theme}`,
      '',
      '1) Create account: https://taptap.blackbucks.me/',
      '',
      '2) Prepare submission:',
      '- GitHub repository link',
      '- Zip with PPT/PDF, documentation, video',
      '',
      '3) Submit project:',
      submitURL,
      '',
      `Contact: ${contactEmail}`,
      `Organization: ${organization}`
    ].join('\n');

    try {
      const info = await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: toList,
        subject,
        text,
        html,
      });
      console.log('[mail] sent', { messageId: info && info.messageId, response: info && info.response });
      return res.json({ status: 'sent', messageId: info && info.messageId });
    } catch (sendErr) {
      console.error('[mail] send failed', sendErr && sendErr.message, sendErr && sendErr.code);
      return res.status(500).json({ error: 'Failed to send registration email', details: sendErr.message, code: sendErr.code });
    }
  } catch (err) {
    console.error('[mail] route error', err && err.message);
    return res.status(500).json({ error: 'Failed to send registration email', details: err.message });
  }
});

const PORT = 9000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  // Initialize git if repo already exists
  initGit();
});
