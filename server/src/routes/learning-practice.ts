import { Router, type Request, type Response, type NextFunction } from 'express';
import { getActor, assertOwner } from '../application/security.js';
import { generatePractice, startPractice, savePracticeDraft, submitPracticeAttempt, retryPracticeItem, archivePracticeQuestion, practiceEvent, updatePracticeSession, regradePractice, updatePracticeJob, updatePracticeReview, saveLearningResume } from '../application/learning-practice/service.js';
import { practiceOverview, searchLearning, readPracticeSession, readPracticeItem, readPracticeJob, practiceHistory, practiceGrades, practiceReviews, practiceReviewEvents, learningActivityPage } from '../application/learning-practice/read.js';
export function createLearningPracticeRouter() {
  const router = Router();
  router.use((req, _res, next) => {
    try {
      assertOwner(getActor(req));
      next();
    }
    catch (error) {
      next(error);
    }
  });
  const run = (handler: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await handler(req), error: null });
    }
    catch (error) {
      next(error);
    }
  };
  router.get('/overview', run(req => practiceOverview(getActor(req))));
  router.get('/search', run(req => searchLearning(req.query, getActor(req))));
  router.get('/activity', run(req => learningActivityPage(req.query, getActor(req))));
  router.get('/practice/sessions/:id', run(req => readPracticeSession(String(req.params.id), getActor(req))));
  router.get('/practice/items/:id', run(req => readPracticeItem(String(req.params.id), getActor(req))));
  router.get('/practice/attempts/:id/grades', run(req => practiceGrades(String(req.params.id), req.query, getActor(req))));
  router.get('/practice/history', run(req => practiceHistory(req.query, getActor(req))));
  router.get('/reviews', run(req => practiceReviews(req.query, getActor(req))));
  router.get('/reviews/:id/events', run(req => practiceReviewEvents(String(req.params.id), req.query, getActor(req))));
  router.get('/jobs/:id', run(req => readPracticeJob(String(req.params.id), getActor(req))));
  router.post('/practice/generate', run(req => generatePractice(req.body, getActor(req))));
  router.post('/practice/start', run(req => startPractice(req.body, getActor(req))));
  router.post('/practice/items/:id/draft', run(req => savePracticeDraft(String(req.params.id), req.body, getActor(req))));
  router.post('/practice/items/:id/submit', run(req => submitPracticeAttempt(String(req.params.id), req.body, getActor(req))));
  router.post('/practice/items/:id/retry', run(req => retryPracticeItem(String(req.params.id), req.body, getActor(req))));
  router.post('/practice/items/:id/archive', run(req => archivePracticeQuestion(String(req.params.id), req.body, getActor(req))));
  router.post('/practice/items/:id/events', run(req => practiceEvent(String(req.params.id), req.body, getActor(req))));
  router.post('/practice/sessions/:id/update', run(req => updatePracticeSession(String(req.params.id), req.body, getActor(req))));
  router.post('/practice/attempts/:id/regrade', run(req => regradePractice(String(req.params.id), req.body, getActor(req))));
  router.post('/reviews/update', run(req => updatePracticeReview(req.body, getActor(req))));
  router.post('/jobs/:id/retry', run(req => updatePracticeJob(String(req.params.id), 'retry', req.body, getActor(req))));
  router.post('/jobs/:id/cancel', run(req => updatePracticeJob(String(req.params.id), 'cancel', req.body, getActor(req))));
  router.post('/resume', run(req => saveLearningResume(req.body, getActor(req))));
  return router;
}
