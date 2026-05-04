import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: (config: Record<string, unknown>) => {
        const required = ['DATABASE_URL', 'REDIS_URL'];
        for (const key of required) {
          if (!config[key]) throw new Error(`Missing required env var: ${key}`);
        }
        return config;
      },
    }),
  ],
})
export class ConfigModule {}
