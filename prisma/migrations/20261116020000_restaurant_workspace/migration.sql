BEGIN;
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "restaurantDuty" TEXT NOT NULL DEFAULT 'COUNTER';

-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "costKnown" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "BusinessWorkspace" (
    "shopId" TEXT NOT NULL,
    "modules" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessWorkspace_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "RestaurantProfile" (
    "shopId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "publicPhone" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "acceptingOrders" BOOLEAN NOT NULL DEFAULT false,
    "hours" JSONB NOT NULL,
    "leadMinutes" INTEGER NOT NULL DEFAULT 20,
    "slotMinutes" INTEGER NOT NULL DEFAULT 15,
    "slotCapacity" INTEGER NOT NULL DEFAULT 10,
    "tables" TEXT[],
    "menuProductIds" TEXT[],
    "unavailableProductIds" TEXT[],
    "allowAssistant" BOOLEAN NOT NULL DEFAULT false,
    "allowCash" BOOLEAN NOT NULL DEFAULT true,
    "allowOnline" BOOLEAN NOT NULL DEFAULT false,
    "paymentCredential" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantProfile_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "RestaurantImport" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "confirmationHash" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "productIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestaurantImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantTicket" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "accessHash" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "notifyWhatsApp" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL,
    "tableName" TEXT,
    "requestedFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "items" JSONB NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "taxRate" DOUBLE PRECISION NOT NULL,
    "taxInclusive" BOOLEAN NOT NULL,
    "currency" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "checkoutState" TEXT NOT NULL DEFAULT 'NONE',
    "checkoutId" TEXT,
    "checkoutUrl" TEXT,
    "chargeId" TEXT,
    "saleId" TEXT,
    "failure" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantReportSubscription" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "localHour" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantReportSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantDelivery" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ticketId" TEXT,
    "key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "meteredAction" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "messageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantProfile_slug_key" ON "RestaurantProfile"("slug");

-- CreateIndex
CREATE INDEX "RestaurantImport_shopId_createdAt_idx" ON "RestaurantImport"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTicket_checkoutId_key" ON "RestaurantTicket"("checkoutId");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTicket_chargeId_key" ON "RestaurantTicket"("chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTicket_saleId_key" ON "RestaurantTicket"("saleId");

-- CreateIndex
CREATE INDEX "RestaurantTicket_shopId_requestedFor_status_idx" ON "RestaurantTicket"("shopId", "requestedFor", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTicket_shopId_requestKey_key" ON "RestaurantTicket"("shopId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantReportSubscription_shopId_kind_channel_key" ON "RestaurantReportSubscription"("shopId", "kind", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantDelivery_key_key" ON "RestaurantDelivery"("key");

-- CreateIndex
CREATE INDEX "RestaurantDelivery_shopId_status_idx" ON "RestaurantDelivery"("shopId", "status");

-- AddForeignKey
ALTER TABLE "BusinessWorkspace" ADD CONSTRAINT "BusinessWorkspace_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantProfile" ADD CONSTRAINT "RestaurantProfile_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantImport" ADD CONSTRAINT "RestaurantImport_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "RestaurantProfile"("shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantTicket" ADD CONSTRAINT "RestaurantTicket_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "RestaurantProfile"("shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantReportSubscription" ADD CONSTRAINT "RestaurantReportSubscription_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "RestaurantProfile"("shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantDelivery" ADD CONSTRAINT "RestaurantDelivery_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "RestaurantTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;


COMMIT;
