import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JsonLogger } from './common/logging/json-logger';
import { CONFIG, type AppConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // bufferLogs so early bootstrap lines are emitted through the JSON logger once it exists,
    // rather than as unstructured Nest text.
    bufferLogs: true,
  });

  app.useLogger(new JsonLogger());
  app.useGlobalFilters(new AllExceptionsFilter());

  // Behind a reverse proxy in production; needed for correct client IPs in rate limiting.
  app.set('trust proxy', 1);

  const config = app.get<AppConfig>(CONFIG);
  await app.listen(config.API_PORT);

  new Logger('Bootstrap').log(
    `API listening on :${config.API_PORT} (${config.NODE_ENV})`,
  );
}

void bootstrap();
