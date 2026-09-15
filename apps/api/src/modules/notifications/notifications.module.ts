import { Module } from '@nestjs/common';

import { GraphqlScalarsModule } from '../../graphql/scalars/scalars.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { InsightsModule } from '../insights/insights.module';
import { NotificationsResolver } from './notifications.resolver';
import { NotificationsService } from './notifications.service';

/**
 * Alerts and notifications (F-22) — docs/05 §9's pipeline.
 *
 * It imports `InsightsModule` and not the other way round: evaluating an alert needs the insights it
 * is about, while generating an insight needs nothing from this module. That keeps the edge
 * one-directional (`notifications → insights`), which is the rule docs/05 §3 sets for every module in
 * the app.
 *
 * The evaluator itself is in `@finmate/domain`, so what decides whether a user is interrupted is
 * arithmetic-free logic the domain package tests on both sides of every boundary.
 */
@Module({
  imports: [PrismaModule, InsightsModule, GraphqlScalarsModule],
  providers: [NotificationsService, NotificationsResolver],
  exports: [NotificationsService],
})
export class NotificationsModule {}
