import { prisma } from './prisma';

export const connectDatabase = async (): Promise<void> => {
  try {
    await prisma.$connect();
    console.log('✓ PostgreSQL connected via Prisma');
  } catch (error) {
    console.error('✗ Failed to connect to PostgreSQL:', error);
    process.exit(1);
  }
};

export const disconnectDatabase = async (): Promise<void> => {
  try {
    await prisma.$disconnect();
    console.log('✓ PostgreSQL disconnected');
  } catch (error) {
    console.error('Error disconnecting from PostgreSQL:', error);
  }
};

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
