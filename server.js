const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');
const multer = require('multer');

// Multer: store uploaded CSV in memory
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Returns the 4 active graduation years: current year + next 3
function getActiveYears() {
  const currentYear = new Date().getFullYear();
  return [currentYear, currentYear + 1, currentYear + 2, currentYear + 3].map(String);
}

function activeYearsSQL() {
  return getActiveYears().map(() => '?').join(',');
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./chromebook_data.db', (err) => {
  if (err) console.error('Database error:', err);
  else console.log('Connected to SQLite database');
});

// Ensure tables exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      last_name TEXT,
      first_name TEXT,
      graduation_year TEXT,
      is_active TEXT DEFAULT 'true'
    )
  `);

  // Add is_active column if it doesn't exist (for existing databases)
  db.run(`
    PRAGMA table_info(students)
  `, (err, result) => {
    if (!err) {
      db.all(`SELECT * FROM pragma_table_info('students')`, (err, columns) => {
        if (!err && columns) {
          const hasIsActive = columns.some(col => col.name === 'is_active');
          if (!hasIsActive) {
            db.run(`ALTER TABLE students ADD COLUMN is_active TEXT DEFAULT 'true'`, (err) => {
              if (err) console.log('Column is_active may already exist or error:', err.message);
              else console.log('Added is_active column to students table');
            });
          }
        }
      });
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS asset_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      asset_tag TEXT NOT NULL,
      returned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(student_id) REFERENCES students(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scan_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      action TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(student_id) REFERENCES students(id)
    )
  `);
});

// API Routes

// Get student info by ID
app.get('/api/student/:id', (req, res) => {
  const studentId = req.params.id;
  db.get('SELECT * FROM students WHERE id = ?', [studentId], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (row) {
      res.json(row);
    } else {
      res.status(404).json({ error: 'Student not found' });
    }
  });
});

// Record asset return
app.post('/api/asset-return', (req, res) => {
  const { student_id, asset_tag } = req.body;

  if (!student_id || !asset_tag) {
    return res.status(400).json({ error: 'student_id and asset_tag are required' });
  }

  // Verify student exists
  db.get('SELECT id FROM students WHERE id = ?', [student_id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Insert asset return
    db.run(
      'INSERT INTO asset_returns (student_id, asset_tag) VALUES (?, ?)',
      [student_id, asset_tag],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        // Log the scan
        db.run('INSERT INTO scan_log (student_id, action) VALUES (?, ?)', 
          [student_id, 'ASSET_RETURNED']);

        // Get updated data
        getAndBroadcastUpdate();

        res.json({
          success: true,
          message: `Asset ${asset_tag} returned for student ${student_id}`,
          return_id: this.lastID
        });
      }
    );
  });
});

// Cancel a return by return record id
app.delete('/api/asset-return/:returnId', (req, res) => {
  const returnId = Number(req.params.returnId);
  if (!Number.isInteger(returnId) || returnId <= 0) {
    return res.status(400).json({ error: 'Invalid return id' });
  }

  db.get('SELECT id, student_id, asset_tag FROM asset_returns WHERE id = ?', [returnId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Return record not found' });

    db.run('DELETE FROM asset_returns WHERE id = ?', [returnId], function(deleteErr) {
      if (deleteErr) return res.status(500).json({ error: deleteErr.message });

      db.run(
        'INSERT INTO scan_log (student_id, action) VALUES (?, ?)',
        [row.student_id, 'ASSET_RETURN_CANCELED']
      );

      getAndBroadcastUpdate();
      return res.json({
        success: true,
        message: `Canceled return ${returnId} (${row.asset_tag}) for student ${row.student_id}`
      });
    });
  });
});

// Get all scans (for dashboard)
app.get('/api/scans', (req, res) => {
  const years = getActiveYears();
  db.all(`
    SELECT 
      ar.id as return_id,
      ar.student_id,
      s.first_name,
      s.last_name,
      s.graduation_year,
      ar.asset_tag,
      ar.returned_at,
      (
        SELECT COUNT(*)
        FROM asset_returns ar2
        WHERE ar2.student_id = ar.student_id
      ) as return_count
    FROM asset_returns ar
    JOIN (
      SELECT student_id, MAX(id) as latest_id
      FROM asset_returns
      GROUP BY student_id
    ) latest ON ar.id = latest.latest_id
    JOIN students s ON ar.student_id = s.id
    WHERE s.graduation_year IN (${activeYearsSQL()})
    ORDER BY ar.returned_at DESC
    LIMIT 50
  `, years, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Get dashboard stats
app.get('/api/stats', (req, res) => {
  db.serialize(() => {
    db.get('SELECT COUNT(DISTINCT student_id) as total_returns FROM asset_returns', 
      (err, row1) => {
        if (err) return res.status(500).json({ error: err.message });

        db.get('SELECT COUNT(*) as total_students FROM students', 
          (err, row2) => {
            if (err) return res.status(500).json({ error: err.message });

            res.json({
              total_returns: row1?.total_returns || 0,
              total_students: row2?.total_students || 0,
              remaining: (row2?.total_students || 0) - (row1?.total_returns || 0)
            });
          }
        );
      }
    );
  });
});

// Get detailed return records
app.get('/api/returns', (req, res) => {
  db.all(`
    SELECT 
      ar.id,
      ar.student_id,
      s.first_name,
      s.last_name,
      s.graduation_year,
      ar.asset_tag,
      ar.returned_at
    FROM asset_returns ar
    JOIN students s ON ar.student_id = s.id
    ORDER BY ar.returned_at DESC
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Helper to load rows from a CSV buffer into the students table
function loadCsvBuffer(buffer, callback) {
  const { Readable } = require('stream');
  db.run('DELETE FROM students', (err) => {
    if (err) return callback(err);

    let insertCount = 0;
    let ended = false;
    let errors = [];

    const rows = [];
    const readable = Readable.from(buffer.toString());
    readable
      .pipe(csv({
        mapHeaders: ({ header }) => header.toLowerCase().replace(/['\"/]/g, '').trim().replace(/\s+/g, '_')
      }))
      .on('data', (row) => rows.push(row))
      .on('end', () => {
        if (rows.length === 0) return callback(null, 0);

        let pending = rows.length;
        rows.forEach((row) => {
          const id = row.student_id?.trim() || '';
          const lastName = row.student_last_name?.trim() || '';
          const firstName = row.student_first_name?.trim() || '';
          const year = row.graduation_year?.trim() || '';
          const isActive = row.is_active?.trim() || 'true';

          if (id) {
            db.run(
              'INSERT OR REPLACE INTO students (id, last_name, first_name, graduation_year, is_active) VALUES (?, ?, ?, ?, ?)',
              [id, lastName, firstName, year, isActive],
              (err) => {
                if (err) errors.push(err);
                pending--;
                if (pending === 0) callback(null, rows.length);
              }
            );
          } else {
            pending--;
            if (pending === 0) callback(null, rows.length);
          }
        });
      })
      .on('error', callback);
  });
}

// Upload new CSV to replace the database
app.post('/api/upload-csv', upload.single('csvfile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded' });
  }

  console.log(`Uploading new CSV: ${req.file.originalname} (${req.file.size} bytes)`);

  // Also overwrite data.csv on disk so future reloads use the new file
  fs.writeFile('data.csv', req.file.buffer, (writeErr) => {
    if (writeErr) console.error('Warning: could not overwrite data.csv:', writeErr.message);
  });

  loadCsvBuffer(req.file.buffer, (err, totalCount) => {
    if (err) {
      console.error('CSV load error:', err);
      return res.status(500).json({ error: 'Failed to process CSV: ' + err.message });
    }

    const years = getActiveYears();
    db.get(
      `SELECT COUNT(*) as count FROM students WHERE graduation_year IN (${activeYearsSQL()})`,
      years,
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        const activeCount = row?.count || 0;
        console.log(`CSV uploaded: ${totalCount} total students, ${activeCount} in active years ${years.join(', ')}`);
        setTimeout(() => getAndBroadcastUpdate(), 50);

        res.json({
          success: true,
          message: `Database updated: ${activeCount} active students (class years ${years.join(', ')}) from ${totalCount} total`,
          total: totalCount,
          active: activeCount,
          years
        });
      }
    );
  });
});

// Get stats by grade/graduation year (active years only)
app.get('/api/stats-by-grade', (req, res) => {
  const years = getActiveYears();
  db.all(
    `SELECT 
      s.graduation_year,
      COUNT(s.id) as total_students,
      COUNT(DISTINCT ar.student_id) as returned_count
     FROM students s
     LEFT JOIN asset_returns ar ON s.id = ar.student_id
     WHERE s.graduation_year IN (${activeYearsSQL()})
     GROUP BY s.graduation_year
     ORDER BY s.graduation_year ASC`,
    years,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const sortedYears = [...years].sort((a, b) => Number(a) - Number(b));
      const gradeNumbers = [12, 11, 10, 9];
      const gradeLabels = ['Senior', 'Junior', 'Sophomore', 'Freshman'];
      const gradeMap = {};
      sortedYears.forEach((y, i) => {
        gradeMap[y] = `Grade ${gradeNumbers[i]} (${gradeLabels[i]})`;
      });

      const data = (rows || []).map(row => ({
        year: row.graduation_year,
        grade: gradeMap[row.graduation_year] || `Class of ${row.graduation_year}`,
        total: row.total_students,
        returned: row.returned_count || 0,
        not_returned: (row.total_students) - (row.returned_count || 0)
      }));
      res.json(data);
    }
  );
});

// Socket.io for real-time updates
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Send current stats when client connects
  getAndBroadcastUpdate();

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Helper function to get and broadcast updates (filtered to active years)
function getAndBroadcastUpdate() {
  const years = getActiveYears();

  db.serialize(() => {
    db.all(`
      SELECT 
        ar.id as return_id,
        ar.student_id,
        s.first_name,
        s.last_name,
        s.graduation_year,
        ar.asset_tag,
        ar.returned_at,
        (
          SELECT COUNT(*)
          FROM asset_returns ar2
          WHERE ar2.student_id = ar.student_id
        ) as asset_count
      FROM asset_returns ar
      JOIN (
        SELECT student_id, MAX(id) as latest_id
        FROM asset_returns
        GROUP BY student_id
      ) latest ON ar.id = latest.latest_id
      JOIN students s ON ar.student_id = s.id
      WHERE s.graduation_year IN (${activeYearsSQL()})
      ORDER BY ar.returned_at DESC
    `, years, (err, rows) => {
      if (!err) io.emit('update_scans', rows || []);
    });

    db.get(
      `SELECT COUNT(DISTINCT ar.student_id) as total_returns
       FROM asset_returns ar
       JOIN students s ON ar.student_id = s.id
       WHERE s.graduation_year IN (${activeYearsSQL()})`,
      years,
      (err, statsRow) => {
        if (!err) {
          db.get(
            `SELECT COUNT(*) as total_students FROM students WHERE graduation_year IN (${activeYearsSQL()})`,
            years,
            (err, countRow) => {
              if (!err) {
                io.emit('update_stats', {
                  total_returns: statsRow?.total_returns || 0,
                  total_students: countRow?.total_students || 0,
                  remaining: (countRow?.total_students || 0) - (statsRow?.total_returns || 0)
                });
              }
            }
          );
        }
      }
    );

    db.all(
      `SELECT 
        s.graduation_year,
        COUNT(s.id) as total_students,
        COUNT(DISTINCT ar.student_id) as returned_count
       FROM students s
       LEFT JOIN asset_returns ar ON s.id = ar.student_id
       WHERE s.graduation_year IN (${activeYearsSQL()})
       GROUP BY s.graduation_year
       ORDER BY s.graduation_year ASC`,
      years,
      (err, rows) => {
        if (err) {
          console.error('Error fetching grade stats:', err);
          io.emit('update_grade_stats', []);
          return;
        }

        // Grade names: lowest year in active set = Grade 12, each subsequent = 11, 10, 9
        const sortedYears = [...years].sort((a, b) => Number(a) - Number(b));
        const gradeNumbers = [12, 11, 10, 9];
        const gradeMap = {};
        sortedYears.forEach((y, i) => {
          const gradeNum = gradeNumbers[i];
          const gradeLabel = gradeNum === 12 ? 'Senior' : gradeNum === 11 ? 'Junior' : gradeNum === 10 ? 'Sophomore' : 'Freshman';
          gradeMap[y] = `Grade ${gradeNum} (${gradeLabel})`;
        });

        const data = (rows || []).map(row => ({
          year: row.graduation_year,
          grade: gradeMap[row.graduation_year] || `Class of ${row.graduation_year}`,
          total: row.total_students || 0,
          returned: row.returned_count || 0,
          not_returned: (row.total_students || 0) - (row.returned_count || 0)
        }));

        io.emit('update_grade_stats', data);
      }
    );
  });
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
