const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const csv = require('csv-parser');

const db = new sqlite3.Database('./chromebook_data.db', (err) => {
  if (err) {
    console.error('Database error:', err);
    process.exit(1);
  }
  console.log('Connected to SQLite database');
});

db.serialize(() => {
  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      last_name TEXT,
      first_name TEXT,
      graduation_year TEXT,
      is_active TEXT DEFAULT 'true'
    )
  `);

  db.run('DELETE FROM students');

  // Read CSV and insert data
  const stream = fs.createReadStream('data.csv')
    .pipe(csv({
      mapHeaders: ({ header }) => header.toLowerCase().replace(/['"]/g, '').replace(/\s+/g, '_')
    }))
    .on('data', (row) => {
      const id = row.student_id?.replace(/['"]/g, '') || '';
      const lastName = row.student_last_name?.replace(/['"]/g, '') || '';
      const firstName = row.student_first_name?.replace(/['"]/g, '') || '';
      const year = row.graduation_year?.replace(/['"]/g, '') || '';
      const isActive = row.is_active?.replace(/['"]/g, '') || 'true';

      if (id) {
        db.run(
          'INSERT INTO students (id, last_name, first_name, graduation_year, is_active) VALUES (?, ?, ?, ?, ?)',
          [id, lastName, firstName, year, isActive],
          (err) => {
            if (err) console.error('Error inserting student:', err);
          }
        );
      }
    })
    .on('end', () => {
      db.get('SELECT COUNT(*) as count FROM students', (err, row) => {
        if (err) {
          console.error('Error:', err);
        } else {
          console.log(`Database initialized with ${row.count} students`);
        }
        db.close();
      });
    })
    .on('error', (err) => {
      console.error('Error reading CSV:', err);
      db.close();
      process.exit(1);
    });
});
