import { Router } from 'express';
import { getActor } from '../application/security.js';
import { ReviewService } from '../application/reviews.js';

export function createReviewsRouter(service = new ReviewService()) {
  const router = Router();
  router.get('/rules', async (req, res, next) => { try { res.json({ data: await service.rules(getActor(req)), error: null }); } catch (error) { next(error); } });
  router.post('/rules', async (req, res, next) => { try { res.json({ data: await service.createRule(getActor(req), req.body), error: null }); } catch (error) { next(error); } });
  router.patch('/rules/:id', async (req, res, next) => { try { res.json({ data: await service.updateRule(getActor(req), String(req.params.id), req.body), error: null }); } catch (error) { next(error); } });
  router.post('/rules/:id/run', async (req, res, next) => { try { res.json({ data: await service.run(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  router.get('/batches', async (req, res, next) => { try { res.json({ data: await service.batches(getActor(req), typeof req.query.ruleId === 'string' ? req.query.ruleId : undefined), error: null }); } catch (error) { next(error); } });
  router.get('/batches/:id', async (req, res, next) => { try { res.json({ data: await service.batch(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  router.post('/batches/:id/retry', async (req, res, next) => { try { res.json({ data: await service.retry(getActor(req), String(req.params.id)), error: null }); } catch (error) { next(error); } });
  return router;
}
