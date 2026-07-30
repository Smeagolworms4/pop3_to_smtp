import { Module } from '@nestjs/common';
import { ApiController } from './api/api.controller';
import { ForwarderService } from './mail/forwarder.service';
import { SmtpService } from './mail/smtp.service';
import { NotifyService } from './notify/notify.service';
import { SchedulerService } from './scheduler.service';
import { StoreService } from './store/store.service';

@Module({
  controllers: [ApiController],
  providers: [StoreService, SmtpService, NotifyService, ForwarderService, SchedulerService],
})
export class AppModule {}
