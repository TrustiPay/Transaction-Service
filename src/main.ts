import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { globalValidationPipe } from './common/pipes/validation.pipe';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.useGlobalPipes(globalValidationPipe);

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`Transaction service running on port ${port}`);
}

bootstrap();
