require('dotenv').config()

const express = require('express')
const cors = require('cors')

const {
  GoogleGenerativeAI
} = require('@google/generative-ai')

const app = express()

app.use(cors())
app.use(express.json())

const genAI =
new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY
)

const model =
genAI.getGenerativeModel({
  model:'gemini-2.5-flash'
})

app.post('/chat',async(req,res)=>{

  try{

    const userMessage =
    req.body.message

    if(!userMessage){

      return res.status(400).json({
        reply:'Няма въведено съобщение.'
      })

    }

    const prompt = `
You are AiOn.

AiOn is a calm intelligent digital organism specialized in TV and technology consultation.

Your communication style:
-Calm
-Human
-Professional
-Friendly
-Short but useful

If the question is unrelated to TVs or technology,you can still answer briefly.

Customer:
${userMessage}

AiOn:
`

    const result =
    await model.generateContent(prompt)

    const response =
    await result.response.text()

    console.log('USER:',userMessage)
    console.log('AION:',response)

    res.json({
      reply:response || 'AiOn няма отговор в момента.'
    })

  }catch(error){

    console.log('ERROR:',error)

    res.status(500).json({
      reply:'AiOn временно не може да отговори.'
    })

  }

})

app.listen(3000,()=>{

  console.log(
    'AiOn backend running on port 3000'
  )

})