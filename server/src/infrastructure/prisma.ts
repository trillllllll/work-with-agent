import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: resolve(process.cwd(), 'server/.env') });
dotenv.config();

export const prisma = new PrismaClient();
