-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "status" "ShopStatus" NOT NULL DEFAULT 'ACTIVE';
