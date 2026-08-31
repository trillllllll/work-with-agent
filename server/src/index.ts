import { app } from './app.js'; app.listen(Number(process.env.PORT)||3001,()=>console.log('API listening on 3001'));
