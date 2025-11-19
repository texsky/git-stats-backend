const express = require('express');
const cors = require('cors');
const simpleGit = require('simple-git');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();
const { Pool } = require('pg');

// ------------------ POSTGRESQL SETUP ------------------

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: 5432,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test the connection once
pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ PostgreSQL connection error:", err.message);
  } else {
    console.log("✅ Connected to PostgreSQL database");
  }
  release();
});

// Listen for unexpected errors
pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle PostgreSQL client:', err);
});

const app = express();
app.use(cors());
app.use(express.json());

// -------------------- AWS SES MAILER --------------------
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const ses = new SESClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

// -------------------------------------------------------

const REPO_DIR = path.join(__dirname, 'cloned_repo');
let git = null;

// Initialize git instance only if repo exists
function initGit() {
  if (fs.existsSync(REPO_DIR)) {
    git = simpleGit(REPO_DIR, {
      timeout: { block: 60000 }
    });
    return true;
  }
  git = null;
  return false;
}

// Clone repository
app.post('/api/clone', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Repository URL is required' });

  try {
    if (fs.existsSync(REPO_DIR)) {
      await fs.remove(REPO_DIR);
      git = null;
    }

    console.log('Cloning repository...');
    await simpleGit().clone(url, REPO_DIR);
    initGit();

    res.json({ message: 'Repository Fetched successfully' });
  } catch (error) {
    console.error('Clone error:', error);
    res.status(500).json({ error: 'Failed to clone repository', details: error.message });
  }
});

// Contributors
app.get('/api/contributors', async (req, res) => {
  try {
    if (!initGit()) return res.status(400).json({ error: 'No repository cloned yet' });

    const log = await git.log();
    const contributorMap = new Map();

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
        const show = await Promise.race([
          git.show([commit.hash, '--stat', '--format=']),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);

        const lines = show.split('\n');
        for (const line of lines) {
          const match = line.match(/(\d+) insertion.*?(\d+) deletion/);
          if (match) {
            contributor.additions += parseInt(match[1]) || 0;
            contributor.deletions += parseInt(match[2]) || 0;
          }
        }
      } catch (_) { }
    }

    const contributors = Array.from(contributorMap.values()).sort((a, b) => b.commits - a.commits);
    res.json(contributors);

  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contributors', details: error.message });
  }
});

// Contributor diffs
app.get('/api/contributor/:username/diffs', async (req, res) => {
  const { username } = req.params;

  try {
    if (!initGit()) return res.status(400).json({ error: 'No repository cloned yet' });

    const log = await git.log();
    const userCommits = log.all.filter(c => c.author_name === username);

    const diffs = [];

    for (const commit of userCommits) {
      try {
        const diffResult = await Promise.race([
          git.show([
            commit.hash,
            '--format=medium',
            '--unified=3',
            '--stat',
            '--max-count=1'
          ]),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Diff timeout')), 10000))
        ]);

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

        const filteredBlocks = fileBlocks.filter(b => {
          return !(
            b.aPath.includes('node_modules/') ||
            b.bPath.includes('node_modules/')
          );
        });

        if (filteredBlocks.length === 0) continue;

        const changes = filteredBlocks.flatMap(b => b.lines);

        diffs.push({
          commit: commit.hash.substring(0, 7),
          message: commit.message.split('\n')[0],
          date: commit.date,
          changes
        });

      } catch (err) {
        diffs.push({
          commit: commit.hash.substring(0, 7),
          message: commit.message.split('\n')[0],
          date: commit.date,
          changes: [
            `// Error loading changes: ${err.message}`,
            '// This commit may contain many changes or binary files'
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

    res.json(diffs);

  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch code changes',
      details: error.message
    });
  }
});

// Delete
app.delete('/api/delete', async (req, res) => {
  try {
    if (fs.existsSync(REPO_DIR)) {
      await fs.remove(REPO_DIR);
      git = null;
      res.json({ message: 'Repository deleted successfully' });
    } else {
      res.status(404).json({ error: 'No repository to delete' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete repository', details: error.message });
  }
});


app.get('/api/submission-record/:email/:hid/:rid', (req, res) => {
  try {
    const { email, hid, rid } = req.params;

    const userQuery = `SELECT id FROM public.user WHERE email = '${email}' LIMIT 1;`

    pool.query(userQuery, (err, userResult) => {
      if (err) {
        return res.status(500).json({ error: 'Database query error', details: err.message });
      }

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const userId = userResult.rows[0].id;


      const query = `SELECT
            ts.*,
            b.id AS block_id,
            b.title AS question_title,
            b.problem_type AS question_type,
            b.coding,
            b.mcq,
            b.subjective
        FROM round_block_order rbo
        JOIN block b
            ON b.id = rbo.block_id
        JOIN test_submission ts
            ON ts.problem_id = b.id
            AND ts.round_id = rbo.round_id
        JOIN round r
            ON r.id = rbo.round_id
        JOIN hackathon h
            ON h.id = r.hackathon_id
        WHERE
            ts.user_id = '${userId}'       -- user_id
            AND r.id = '${rid}'         -- round_id
            AND h.id = '${hid}'         -- hackathon_id
        ORDER BY ts.update_at DESC
        LIMIT 1;
      `

      pool.query(query, (err, result) => {
        if (err) {
          return res.status(500).json({ error: 'Database query error', details: err.message });
        }

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Submission record not found' });
        }

        res.json(result.rows[0].submission);
      });

    });

  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch submission record', details: err.message });
  }
})

// Bulk submission records: given list of { email, hid, rid } return GitHub links
app.post('/api/submission-records/bulk', async (req, res) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const results = [];

    for (const item of items) {
      const { email, hid, rid } = item || {};
      if (!email || !hid || !rid) {
        continue;
      }

      try {
        const userQuery = `SELECT id FROM public.user WHERE email = '${email}' LIMIT 1;`;
        const userResult = await pool.query(userQuery);

        if (userResult.rows.length === 0) {
          results.push({ email, hid, rid, githubLink: null, error: 'User not found' });
          continue;
        }

        const userId = userResult.rows[0].id;

        const query = `SELECT
            ts.*,
            b.id AS block_id,
            b.title AS question_title,
            b.problem_type AS question_type,
            b.coding,
            b.mcq,
            b.subjective
        FROM round_block_order rbo
        JOIN block b
            ON b.id = rbo.block_id
        JOIN test_submission ts
            ON ts.problem_id = b.id
            AND ts.round_id = rbo.round_id
        JOIN round r
            ON r.id = rbo.round_id
        JOIN hackathon h
            ON h.id = r.hackathon_id
        WHERE
            ts.user_id = '${userId}'
            AND r.id = '${rid}'
            AND h.id = '${hid}'
        ORDER BY ts.update_at DESC
        LIMIT 1;`;

        const submissionResult = await pool.query(query);
        if (submissionResult.rows.length === 0) {
          results.push({ email, hid, rid, githubLink: null, error: 'Submission record not found' });
          continue;
        }

        const submission = submissionResult.rows[0].submission;
        const githubLink = submission?.files?.githubLink || null;

        results.push({ email, hid, rid, githubLink });
      } catch (err) {
        results.push({ email, hid, rid, githubLink: null, error: err.message });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error('Bulk submission records error:', err);
    res.status(500).json({ error: 'Failed to fetch bulk submission records', details: err.message });
  }
});

// ------------------ REGISTRATION EMAIL via AWS SES ------------------

app.post('/api/registration-email', async (req, res) => {
  try {
    const { teamName, theme, members, submissionLink } = req.body || {};

    if (!teamName || !theme || !Array.isArray(members))
      return res.status(400).json({ error: 'Missing teamName/theme/members' });

    const toList = members.map(m => m.email).filter(Boolean);

    if (!toList.length) {
      return res.status(400).json({ error: 'No valid recipient email addresses found' });
    }

    const subject = `Hackathon Submission Instructions — ${theme}`;
    const submitURL =
      submissionLink || 'https://taptap.blackbucks.me/hackathon/results/5729/?testType=19';

    const organization = 'BlackBucks Group';
    const contactEmail = 'productteam@blackbucks.me';

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
    <a href="${submitURL}" class="button" style="color:white;">Submit Project</a>

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

    const text = `
Hackathon Submission Instructions
Team: ${teamName}
Hackathon: ${theme}

1) Create account: https://taptap.blackbucks.me/

2) Submission:
- GitHub repository
- ZIP with PPT/PDF, documentation, video

3) Submit:
${submitURL}

Contact: ${contactEmail}
Organization: ${organization}
`;

    const params = {
      Source: contactEmail,
      Destination: { ToAddresses: toList },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: html, Charset: "UTF-8" },
          Text: { Data: text, Charset: "UTF-8" }
        }
      }
    };

    const command = new SendEmailCommand(params);
    const result = await ses.send(command);

    console.log("EMAIL SENT via SES:", result);

    res.json({ status: 'sent', messageId: result.MessageId });

  } catch (err) {
    console.error('SES Email error:', err);
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});


// ------------------ SERVER ------------------

const PORT = 9000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  initGit();
});
