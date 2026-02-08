-- AlterTable: Make password column nullable for User
-- Staff users can authenticate with PIN only
ALTER TABLE "User" ALTER COLUMN "password" DROP NOT NULL;
