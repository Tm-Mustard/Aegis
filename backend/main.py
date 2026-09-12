from fastapi import FastAPI, WebSocket

app=FastAPI()

@app.get("/")
def status():
    return{"status":"connected"}