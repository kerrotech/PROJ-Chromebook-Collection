# Chromebook Asset Return Tracking System

A real-time web application for tracking chromebook asset returns from students. Built with Node.js, Express, SQLite3, and Socket.io for live updates across multiple users.

## Features

- 🔍 **Student Lookup**: Search for students by ID
- 📋 **Asset Tracking**: Record chromebook assets with asset tags
- 📊 **Real-time Dashboard**: Live updates showing who has returned assets and who hasn't
- 💾 **SQLite Database**: Persistent storage of student data and returns
- 🌐 **Multi-User Support**: Multiple people can use the app simultaneously and see live updates
- 🎨 **Modern UI**: Clean, responsive interface with dark theme

## Setup Instructions

### Prerequisites
- Node.js (v14 or higher)
- npm (comes with Node.js)

### Installation

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Initialize Database**
   This will load your `data.csv` file into the SQLite database:
   ```bash
   npm run init-db
   ```

3. **Start the Server**
   ```bash
   npm start
   ```

   The server will start on `http://localhost:3000`

### Development Mode

For development with auto-restart on file changes:
```bash
npm run dev
```

This requires `nodemon` which is already installed as a dev dependency.

## Usage

1. Open your browser and navigate to `http://localhost:3000`
2. Enter a student ID in the search box
3. Click "Search Student" or press Enter
4. When the student is found, a modal will appear asking for the asset tag
5. Enter the chromebook's asset tag/serial number
6. Submit to record the return
7. The live dashboard will update in real-time for all connected users

## Database Structure

### Tables

**students**
- `id` (TEXT, PRIMARY KEY): Student ID
- `last_name` (TEXT): Student's last name
- `first_name` (TEXT): Student's first name
- `graduation_year` (TEXT): Year of graduation

**asset_returns**
- `id` (INTEGER, PRIMARY KEY): Return record ID
- `student_id` (TEXT, FOREIGN KEY): Reference to student
- `asset_tag` (TEXT): Asset/serial number of the chromebook
- `returned_at` (DATETIME): Timestamp of return

**scan_log**
- `id` (INTEGER, PRIMARY KEY): Log entry ID
- `student_id` (TEXT, FOREIGN KEY): Reference to student
- `action` (TEXT): Action type (e.g., "ASSET_RETURNED")
- `timestamp` (DATETIME): When the action occurred

## API Endpoints

- `GET /api/student/:id` - Get student information
- `POST /api/asset-return` - Record an asset return
  - Body: `{ student_id, asset_tag }`
- `GET /api/scans` - Get recent scans (last 50)
- `GET /api/returns` - Get all return records
- `GET /api/stats` - Get dashboard statistics

## Socket.io Events

**Incoming:**
- `update_scans` - List of recent scans (real-time)
- `update_stats` - Dashboard statistics (real-time)

## Files

- `server.js` - Main Express server with API endpoints
- `init-db.js` - Database initialization script
- `public/index.html` - Frontend application
- `package.json` - Dependencies and scripts
- `data.csv` - Student data (loaded into database)
- `chromebook_data.db` - SQLite database (created automatically)

## Troubleshooting

**Database not initializing:**
- Make sure `data.csv` is in the project root
- Run `npm run init-db` again

**Port 3000 already in use:**
- Change the port: `PORT=3001 npm start`
- Or kill the process using port 3000

**Connection issues:**
- Check that the server is running
- Clear browser cache and refresh
- Check browser console for errors (F12)

## Notes

- The CSV file is imported once during initialization
- You can add more students by updating the database through the API or directly
- All asset returns are timestamped and stored in the database
- The real-time update system uses WebSockets to push updates to all connected clients

## Future Enhancements

- Database admin interface for editing/viewing records
- Export data to CSV/PDF reports
- Barcode/QR code scanning support
- Multi-user authentication
- Asset inventory management
