import dotenv from 'dotenv';
dotenv.config();

import app from '@/app';
import { connectDatabase } from '@config/database';

const PORT = process.env.PORT || 3007;

const startServer = async (): Promise<void> => {
  try {
    await connectDatabase();

    app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════╗
║                                           ║
║   🛒 YeboMart API Server                  ║
║                                           ║
║   Port: ${PORT}                              ║
║   Environment: ${process.env.NODE_ENV || 'development'}               ║
║                                           ║
║   Health: http://localhost:${PORT}/health    ║
║   API:    http://localhost:${PORT}/api       ║
║                                           ║
╚═══════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  process.exit(0);
});
