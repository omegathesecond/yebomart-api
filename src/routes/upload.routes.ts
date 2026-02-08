import { Router } from 'express';
import multer from 'multer';
import { uploadImage } from '../controllers/upload.controller';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept images only
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// POST /api/upload - Upload an image
router.post('/', authenticateToken, upload.single('file'), uploadImage);

export default router;
