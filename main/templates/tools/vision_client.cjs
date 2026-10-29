// Compatibility facade; text and images share the product AI service.
const {AIService}=require('./ai_service.cjs')
class VisionClient extends AIService{}
module.exports={VisionClient}
