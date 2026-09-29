import { initializeSentry } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';
initializeSentry('orchestrator', true);
import 'source-map-support/register';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '@gitroom/orchestrator/app.module';
import * as dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Cloudflare deployment: activity arguments (posts with their content)
  // arrive as JSON
  if (process.env.WORKFLOWS_URL) {
    app.useBodyParser('json', { limit: '50mb' });
  }
  app.enableShutdownHooks();
  const port = process.env.ORCHESTRATOR_PORT || 3002;
  await app.listen(port);
  console.log(`Orchestrator health check listening on port ${port}`);
}

bootstrap();
